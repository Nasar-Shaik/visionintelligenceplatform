"""ONVIF discovery and capability negotiation (AI-5e, deliverable 1).

**Why this exists.** Every camera on a customer's network already knows its own manufacturer, model,
firmware, stream profiles, resolutions, frame rates, codecs and whether it can pan. The platform has
been *asking an operator to type all of that in*. Discovery replaces the typing, and — more
importantly — replaces **probing**: the runtime consumes declared capabilities (`CameraCapabilities`,
P2-2 G-1) and never opens a stream to find out what it is. Probing costs a connection and a decode on
every session start, which on a 64-camera site after a power cut is 64 connections nobody needed.

**Structure.** Two seams, both Protocols, both replaceable:

  - `DiscoveryTransport` — WS-Discovery multicast probe. Real implementation uses a UDP socket.
  - `SoapTransport`      — SOAP calls to the device. Real implementation uses urllib.

Both have deterministic simulated implementations, which is what lets the whole ONVIF path be
unit-tested with no network, no camera and no threads — the same discipline as every other tier.
Nothing here reaches the perception pipeline: discovery produces *configuration*, and configuration
is data.

**Credentials.** ONVIF authenticates with WS-Security UsernameToken (SHA-1 digest of nonce + created +
password). The password is used to compute a digest and is never stored on the client, never placed in
a URI, and never logged — consistent with the platform's standing rule that credentials are referenced
(`credentialRef`), not embedded.

Stdlib-only (`socket`, `urllib`, `xml.etree`, `hashlib`, `base64`). Heavy work is lazily imported.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Protocol, Sequence, Tuple

# --- namespaces -----------------------------------------------------------------

NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "d": "http://schemas.xmlsoap.org/ws/2005/04/discovery",
    "a": "http://schemas.xmlsoap.org/ws/2004/08/addressing",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}

WS_DISCOVERY_ADDRESS = "239.255.255.250"
WS_DISCOVERY_PORT = 3702

#: ONVIF encodings → the platform's `CameraCodec` enum. Anything unrecognised is dropped rather than
#: guessed: a codec the decoder cannot actually handle is worse than an absent declaration, because
#: the runtime would clamp to it and then fail on the first frame.
_CODEC_MAP = {"H264": "h264", "H265": "h265", "HEVC": "h265"}

#: The smallest resolution still useful for person detection. Sub-stream selection prefers the
#: smallest profile at or above this; below it, detection recall falls off a cliff and the cheap
#: stream stops being a saving.
_MIN_ANALYSIS_PIXELS = 640 * 360


class OnvifError(RuntimeError):
    """ONVIF negotiation failed. Deliberately NOT a `ConnectionFailure`: a device that will not answer
    a SOAP call is a *configuration* problem for an operator (wrong credentials, ONVIF disabled), not
    something the reconnect supervisor should retry forever."""


# --- seams ----------------------------------------------------------------------


class DiscoveryTransport(Protocol):
    """Sends a WS-Discovery Probe and returns the raw XML of every ProbeMatch received."""

    def probe(self, *, timeout_seconds: float) -> List[str]: ...


class SoapTransport(Protocol):
    """Posts a SOAP envelope to a device service endpoint and returns the response body."""

    def call(self, url: str, envelope: str, *, action: str, timeout_seconds: float) -> str: ...


# --- discovered device ----------------------------------------------------------


@dataclass
class StreamProfile:
    """One named stream the device publishes. Mirrors `CameraStreamProfile` (@vip/contracts)."""

    name: str
    token: str = ""
    codec: Optional[str] = None
    width: int = 0
    height: int = 0
    fps: Optional[int] = None
    path: Optional[str] = None
    ptz: bool = False
    audio: bool = False
    metadata: bool = False
    preferred_for_analysis: bool = False

    @property
    def resolution(self) -> Optional[str]:
        return f"{self.width}x{self.height}" if self.width and self.height else None

    @property
    def pixels(self) -> int:
        return self.width * self.height

    def to_dict(self) -> dict:
        out: dict = {"name": self.name, "preferredForAnalysis": self.preferred_for_analysis}
        for key, value in (
            ("codec", self.codec),
            ("resolution", self.resolution),
            ("fps", self.fps),
            ("path", self.path),
        ):
            if value:
                out[key] = value
        return out


@dataclass
class DiscoveredDevice:
    """Everything discovery learned about one device. Converts directly into the existing
    `CameraMetadata` + `CameraCapabilities` contracts — discovery introduces no new camera model."""

    address: str
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    firmware: Optional[str] = None
    serial_number: Optional[str] = None
    hardware_id: Optional[str] = None
    onvif_version: Optional[str] = None
    scopes: Sequence[str] = ()
    profiles: List[StreamProfile] = field(default_factory=list)
    ptz: bool = False
    audio: bool = False
    metadata_stream: bool = False
    snapshot: bool = True
    discovered_at: Optional[str] = None

    # --- contract projections ---------------------------------------------

    def to_metadata(self) -> dict:
        """A `CameraMetadata` dict. Only fields the device actually reported."""
        out: dict = {"tags": []}
        for key, value in (
            ("manufacturer", self.manufacturer),
            ("model", self.model),
            ("firmware", self.firmware),
            ("serialNumber", self.serial_number),
        ):
            if value:
                out[key] = value
        return out

    def to_capabilities(self) -> dict:
        """A `CameraCapabilities` dict — the thing the runtime CONSUMES instead of probing."""
        codecs = sorted({p.codec for p in self.profiles if p.codec})
        resolutions = sorted({p.resolution for p in self.profiles if p.resolution})
        rates = [p.fps for p in self.profiles if p.fps]
        out: dict = {
            "ptz": self.ptz,
            "audio": self.audio,
            "snapshot": self.snapshot,
            "codecs": codecs,
            "resolutions": resolutions,
            "protocols": ["rtsp"],
            "streamProfiles": [p.to_dict() for p in self.profiles],
            "onvif": True,
            "metadataStream": self.metadata_stream,
        }
        if rates:
            out["fpsRange"] = {"min": max(1, min(rates)), "max": min(120, max(rates))}
        if self.discovered_at:
            out["discoveredAt"] = self.discovered_at
        return out

    @property
    def label(self) -> str:
        parts = [p for p in (self.manufacturer, self.model) if p]
        return " ".join(parts) if parts else self.address

    @property
    def registry_id(self) -> str:
        """Stable slug for the compatibility registry: `hikvision-ds2cd2143g2`."""
        return _slug(f"{self.manufacturer or 'unknown'}-{self.model or 'device'}")


# --- discovery ------------------------------------------------------------------


class OnvifDiscovery:
    """WS-Discovery: find ONVIF devices on the local network without knowing their addresses."""

    def __init__(
        self,
        transport: DiscoveryTransport,
        *,
        now_iso: Callable[[], str] = None,  # noqa: ANN001
    ) -> None:
        self._transport = transport
        self._now_iso = now_iso or _now_iso

    def discover(self, *, timeout_seconds: float = 3.0) -> List[DiscoveredDevice]:
        """Probe and parse. Returns one device per unique service address.

        Devices that answer with unparseable XML are **skipped, not raised**: one malformed responder
        on a VLAN must not prevent an installer from onboarding the other fifteen cameras.
        """
        devices: Dict[str, DiscoveredDevice] = {}
        for payload in self._transport.probe(timeout_seconds=timeout_seconds):
            try:
                device = self._parse_match(payload)
            except (ET.ParseError, ValueError):
                continue
            if device is not None and device.address not in devices:
                devices[device.address] = device
        return sorted(devices.values(), key=lambda d: d.address)

    def _parse_match(self, payload: str) -> Optional[DiscoveredDevice]:
        root = ET.fromstring(payload)
        # The service URL lives in `d:XAddrs` (a space-separated list). `a:Address` inside the
        # EndpointReference is the device's `urn:uuid:` identity, NOT something you can call —
        # reading that instead is the classic WS-Discovery mistake and yields zero usable devices.
        addresses: List[str] = []
        for el in root.iter(f"{{{NS['d']}}}XAddrs"):
            addresses.extend(a for a in (el.text or "").split() if a.startswith("http"))
        if not addresses:
            return None
        scopes_text = " ".join(
            (el.text or "") for el in root.iter(f"{{{NS['d']}}}Scopes")
        ).split()
        device = DiscoveredDevice(
            address=addresses[0],
            scopes=tuple(scopes_text),
            discovered_at=self._now_iso(),
        )
        # ONVIF encodes hardware/name/location in the scope list; it is the only identity available
        # before authentication, so a device that refuses credentials is still recognisable.
        for scope in scopes_text:
            if "/name/" in scope:
                device.model = device.model or _unquote(scope.rsplit("/name/", 1)[-1])
            elif "/hardware/" in scope:
                device.hardware_id = device.hardware_id or _unquote(scope.rsplit("/hardware/", 1)[-1])
        return device


# --- capability negotiation -----------------------------------------------------


class OnvifDevice:
    """Capability negotiation against one device: identity → services → profiles → stream URIs.

    Every call is best-effort in the sense that a device refusing an *optional* service (PTZ, audio,
    metadata) yields a negative capability rather than an error. A device refusing `GetProfiles`
    raises, because without profiles there is nothing to configure and pretending otherwise would
    produce a camera record that cannot stream.
    """

    def __init__(
        self,
        address: str,
        transport: SoapTransport,
        *,
        username: Optional[str] = None,
        password: Optional[str] = None,
        timeout_seconds: float = 5.0,
        now_iso: Callable[[], str] = None,  # noqa: ANN001
    ) -> None:
        self.address = address
        self._transport = transport
        self._username = username
        self._password = password
        self._timeout = timeout_seconds
        self._now_iso = now_iso or _now_iso
        self._media_url: Optional[str] = None

    # --- public -----------------------------------------------------------

    def negotiate(self, device: Optional[DiscoveredDevice] = None) -> DiscoveredDevice:
        """Run the full negotiation and return a fully-populated device."""
        out = device or DiscoveredDevice(address=self.address)
        self._read_identity(out)
        self._read_services(out)
        self._read_profiles(out)
        self._read_stream_uris(out)
        select_analysis_profile(out.profiles)
        out.ptz = out.ptz or any(p.ptz for p in out.profiles)
        out.audio = out.audio or any(p.audio for p in out.profiles)
        out.metadata_stream = out.metadata_stream or any(p.metadata for p in out.profiles)
        out.discovered_at = self._now_iso()
        return out

    # --- steps ------------------------------------------------------------

    def _read_identity(self, out: DiscoveredDevice) -> None:
        body = "<tds:GetDeviceInformation/>"
        try:
            root = self._call(self.address, body, action=f"{NS['tds']}/GetDeviceInformation")
        except OnvifError:
            return  # identity is nice-to-have; profiles are not
        out.manufacturer = _text(root, f".//{{{NS['tds']}}}Manufacturer") or out.manufacturer
        out.model = _text(root, f".//{{{NS['tds']}}}Model") or out.model
        out.firmware = _text(root, f".//{{{NS['tds']}}}FirmwareVersion") or out.firmware
        out.serial_number = _text(root, f".//{{{NS['tds']}}}SerialNumber") or out.serial_number
        out.hardware_id = _text(root, f".//{{{NS['tds']}}}HardwareId") or out.hardware_id

    def _read_services(self, out: DiscoveredDevice) -> None:
        try:
            root = self._call(
                self.address, "<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>",
                action=f"{NS['tds']}/GetCapabilities",
            )
        except OnvifError:
            self._media_url = self.address
            return
        media = root.find(f".//{{{NS['tt']}}}Media")
        if media is not None:
            self._media_url = _text(media, f".//{{{NS['tt']}}}XAddr") or self.address
            snapshot = _text(media, f".//{{{NS['tt']}}}SnapshotUri")
            if snapshot is not None:
                out.snapshot = snapshot.strip().lower() == "true"
        else:
            self._media_url = self.address
        out.ptz = root.find(f".//{{{NS['tt']}}}PTZ") is not None
        analytics = root.find(f".//{{{NS['tt']}}}Analytics")
        out.metadata_stream = analytics is not None
        version_major = _text(root, f".//{{{NS['tt']}}}Major")
        version_minor = _text(root, f".//{{{NS['tt']}}}Minor")
        if version_major:
            out.onvif_version = f"{version_major}.{version_minor or '0'}"

    def _read_profiles(self, out: DiscoveredDevice) -> None:
        url = self._media_url or self.address
        root = self._call(url, "<trt:GetProfiles/>", action=f"{NS['trt']}/GetProfiles")
        profiles: List[StreamProfile] = []
        for el in root.iter(f"{{{NS['trt']}}}Profiles"):
            profiles.append(self._parse_profile(el))
        if not profiles:
            raise OnvifError(f"device at {self.address} published no media profiles")
        out.profiles = profiles

    def _parse_profile(self, el: ET.Element) -> StreamProfile:
        encoder = el.find(f"{{{NS['tt']}}}VideoEncoderConfiguration")
        width = height = 0
        codec = None
        fps = None
        if encoder is not None:
            codec = _CODEC_MAP.get((_text(encoder, f"{{{NS['tt']}}}Encoding") or "").upper())
            resolution = encoder.find(f"{{{NS['tt']}}}Resolution")
            if resolution is not None:
                width = _int(_text(resolution, f"{{{NS['tt']}}}Width"))
                height = _int(_text(resolution, f"{{{NS['tt']}}}Height"))
            limit = _text(encoder, f".//{{{NS['tt']}}}FrameRateLimit")
            fps = _int(limit) or None
        return StreamProfile(
            name=_text(el, f"{{{NS['tt']}}}Name") or el.get("token") or "profile",
            token=el.get("token") or "",
            codec=codec,
            width=width,
            height=height,
            fps=fps,
            ptz=el.find(f"{{{NS['tt']}}}PTZConfiguration") is not None,
            audio=el.find(f"{{{NS['tt']}}}AudioEncoderConfiguration") is not None,
            metadata=el.find(f"{{{NS['tt']}}}MetadataConfiguration") is not None,
        )

    def _read_stream_uris(self, out: DiscoveredDevice) -> None:
        url = self._media_url or self.address
        for profile in out.profiles:
            body = (
                "<trt:GetStreamUri>"
                "<trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream>"
                "<tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup>"
                f"<trt:ProfileToken>{profile.token}</trt:ProfileToken>"
                "</trt:GetStreamUri>"
            )
            try:
                root = self._call(url, body, action=f"{NS['trt']}/GetStreamUri")
            except OnvifError:
                continue
            uri = _text(root, f".//{{{NS['tt']}}}Uri")
            if uri:
                # Only the path is retained. A device commonly returns a URI with credentials already
                # embedded; storing that would put a password into the camera record, which is exactly
                # what `credentialRef` exists to prevent.
                profile.path = _path_of(uri)

    # --- SOAP -------------------------------------------------------------

    def _call(self, url: str, body: str, *, action: str) -> ET.Element:
        envelope = self._envelope(body)
        try:
            response = self._transport.call(
                url, envelope, action=action, timeout_seconds=self._timeout
            )
        except Exception as exc:  # noqa: BLE001 - transport-agnostic seam
            raise OnvifError(f"{action.rsplit('/', 1)[-1]} failed: {exc}") from exc
        try:
            root = ET.fromstring(response)
        except ET.ParseError as exc:
            raise OnvifError(f"{action.rsplit('/', 1)[-1]} returned malformed XML") from exc
        fault = root.find(f".//{{{NS['s']}}}Fault")
        if fault is not None:
            reason = _text(fault, f".//{{{NS['s']}}}Text") or "unspecified"
            raise OnvifError(f"{action.rsplit('/', 1)[-1]} faulted: {reason}")
        return root

    def _envelope(self, body: str) -> str:
        header = self._security_header()
        return (
            '<?xml version="1.0" encoding="UTF-8"?>'
            f'<s:Envelope xmlns:s="{NS["s"]}" xmlns:tds="{NS["tds"]}" '
            f'xmlns:trt="{NS["trt"]}" xmlns:tt="{NS["tt"]}">'
            f"{header}<s:Body>{body}</s:Body></s:Envelope>"
        )

    def _security_header(self) -> str:
        """WS-Security UsernameToken with a SHA-1 password digest.

        The digest is `Base64(SHA1(nonce + created + password))`. The password itself never appears in
        the envelope, which matters because ONVIF is routinely spoken over plain HTTP inside a
        customer LAN — a plaintext token would put a camera password on the wire in cleartext.
        """
        if not self._username or not self._password:
            return ""
        nonce = os.urandom(16)
        created = self._now_iso()
        digest = base64.b64encode(
            hashlib.sha1(nonce + created.encode("utf-8") + self._password.encode("utf-8")).digest()
        ).decode("ascii")
        return (
            '<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/'
            'oasis-200401-wss-wssecurity-secext-1.0.xsd">'
            f"<UsernameToken><Username>{_escape(self._username)}</Username>"
            '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-'
            f'profile-1.0#PasswordDigest">{digest}</Password>'
            '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-'
            f'security-1.0#Base64Binary">{base64.b64encode(nonce).decode("ascii")}</Nonce>'
            '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-'
            f'utility-1.0.xsd">{created}</Created>'
            "</UsernameToken></Security></s:Header>"
        )


def select_analysis_profile(profiles: Sequence[StreamProfile]) -> Optional[StreamProfile]:
    """Mark the profile the runtime should analyze, and return it.

    **Prefer the smallest stream that is still big enough.** Analyzing a 4K main stream when a
    640×360 sub-stream would do wastes decode and inference budget on every single frame, forever —
    it is the cheapest performance decision in the platform. But going *below* roughly 640×360 costs
    detection recall, so the rule is "smallest at or above the analysis floor", falling back to the
    largest available when every profile is below it (a low-resolution-only device should analyze its
    best stream, not its worst).
    """
    usable = [p for p in profiles if p.pixels > 0]
    for p in profiles:
        p.preferred_for_analysis = False
    if not usable:
        return None
    above = [p for p in usable if p.pixels >= _MIN_ANALYSIS_PIXELS]
    chosen = min(above, key=lambda p: p.pixels) if above else max(usable, key=lambda p: p.pixels)
    chosen.preferred_for_analysis = True
    return chosen


# --- real transports (integration-only, lazy) -----------------------------------


class UdpDiscoveryTransport:
    """Real WS-Discovery over UDP multicast. Integration-only; imports `socket` lazily."""

    def __init__(self, *, address: str = WS_DISCOVERY_ADDRESS, port: int = WS_DISCOVERY_PORT) -> None:
        self._address = address
        self._port = port

    def probe(self, *, timeout_seconds: float = 3.0) -> List[str]:
        import socket  # noqa: WPS433 - integration-only

        message = _probe_message()
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.settimeout(timeout_seconds)
        responses: List[str] = []
        try:
            sock.sendto(message.encode("utf-8"), (self._address, self._port))
            deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < deadline:
                try:
                    data, _addr = sock.recvfrom(65535)
                except OSError:
                    break  # timeout — devices answer within the window or not at all
                responses.append(data.decode("utf-8", errors="replace"))
        finally:
            sock.close()
        return responses


class HttpSoapTransport:
    """Real SOAP over HTTP via `urllib`. Integration-only."""

    def call(self, url: str, envelope: str, *, action: str, timeout_seconds: float = 5.0) -> str:
        from urllib import request  # noqa: WPS433 - integration-only

        req = request.Request(
            url,
            data=envelope.encode("utf-8"),
            headers={
                "Content-Type": f'application/soap+xml; charset=utf-8; action="{action}"',
                "Accept": "application/soap+xml",
            },
            method="POST",
        )
        with request.urlopen(req, timeout=timeout_seconds) as response:  # noqa: S310 - operator-supplied device URL
            return response.read().decode("utf-8", errors="replace")


# --- simulated transports (deterministic; the CI path) --------------------------


class SimulatedDiscoveryTransport:
    """Replays canned ProbeMatch payloads. No socket, no thread, no network."""

    def __init__(self, payloads: Sequence[str]) -> None:
        self._payloads = list(payloads)

    def probe(self, *, timeout_seconds: float = 3.0) -> List[str]:
        return list(self._payloads)


class SimulatedSoapTransport:
    """Answers SOAP calls from a canned `{action-suffix: response}` map.

    An action with no canned response raises, which is how a device that refuses an optional service
    is modelled — the negotiation must degrade to a negative capability, not to an exception.
    """

    def __init__(self, responses: Dict[str, str]) -> None:
        self._responses = dict(responses)
        self.calls: List[Tuple[str, str]] = []

    def call(self, url: str, envelope: str, *, action: str, timeout_seconds: float = 5.0) -> str:
        name = action.rsplit("/", 1)[-1]
        self.calls.append((url, name))
        if name not in self._responses:
            raise OnvifError(f"simulated device does not implement {name}")
        return self._responses[name]


def _probe_message() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<s:Envelope xmlns:s="{NS["s"]}" xmlns:a="{NS["a"]}" xmlns:d="{NS["d"]}">'
        f"<s:Header><a:MessageID>uuid:{uuid.uuid4()}</a:MessageID>"
        "<a:To s:mustUnderstand=\"1\">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>"
        '<a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>'
        "</s:Header><s:Body><d:Probe>"
        '<d:Types xmlns:dn="http://www.onvif.org/ver10/network/wsdl">dn:NetworkVideoTransmitter</d:Types>'
        "</d:Probe></s:Body></s:Envelope>"
    )


# --- helpers --------------------------------------------------------------------


def _text(el: Optional[ET.Element], path: str) -> Optional[str]:
    if el is None:
        return None
    found = el.find(path)
    return (found.text or "").strip() if found is not None and found.text else None


def _int(value: Optional[str]) -> int:
    try:
        return int(float(value)) if value else 0
    except (TypeError, ValueError):
        return 0


def _path_of(uri: str) -> str:
    """The path+query of a stream URI, with any host and credentials stripped."""
    if "://" not in uri:
        return uri
    remainder = uri.split("://", 1)[1]
    return "/" + remainder.split("/", 1)[1] if "/" in remainder else "/"


def _unquote(value: str) -> str:
    from urllib.parse import unquote  # noqa: WPS433

    return unquote(value)


def _slug(value: str) -> str:
    out = []
    for ch in value.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "unknown-device"


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


def _now_iso() -> str:
    now = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now * 1000) % 1000:03d}Z"
