"""AI-5e ONVIF discovery + capability negotiation tests.

Everything here runs against `SimulatedDiscoveryTransport` / `SimulatedSoapTransport` — no socket,
no camera, no thread. The XML fixtures are the shapes real devices actually return (including the
awkward ones: a device that refuses `GetCapabilities`, a stream URI with credentials already baked
in, a responder that answers with garbage).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from onvif import (  # noqa: E402
    DiscoveredDevice,
    OnvifDevice,
    OnvifDiscovery,
    OnvifError,
    SimulatedDiscoveryTransport,
    SimulatedSoapTransport,
    StreamProfile,
    select_analysis_profile,
)

AT = lambda: "2026-08-01T00:00:00.000Z"  # noqa: E731

PROBE_MATCH = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
            xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
 <s:Body><d:ProbeMatches><d:ProbeMatch>
   <a:EndpointReference><a:Address>urn:uuid:abc-123</a:Address></a:EndpointReference>
   <d:Scopes>onvif://www.onvif.org/name/DS-2CD2143G2 onvif://www.onvif.org/hardware/DS-2CD2143G2 onvif://www.onvif.org/location/Lobby</d:Scopes>
   <d:XAddrs>http://192.168.1.64/onvif/device_service</d:XAddrs>
 </d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>"""

DEVICE_INFO = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
 <s:Body><tds:GetDeviceInformationResponse>
   <tds:Manufacturer>Hikvision</tds:Manufacturer>
   <tds:Model>DS-2CD2143G2</tds:Model>
   <tds:FirmwareVersion>V5.7.3</tds:FirmwareVersion>
   <tds:SerialNumber>DS2CD00112233</tds:SerialNumber>
   <tds:HardwareId>88</tds:HardwareId>
 </tds:GetDeviceInformationResponse></s:Body></s:Envelope>"""

CAPABILITIES = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
 <s:Body><tds:GetCapabilitiesResponse><tds:Capabilities>
   <tt:Media><tt:XAddr>http://192.168.1.64/onvif/media_service</tt:XAddr>
     <tt:StreamingCapabilities><tt:SnapshotUri>true</tt:SnapshotUri></tt:StreamingCapabilities></tt:Media>
   <tt:PTZ><tt:XAddr>http://192.168.1.64/onvif/ptz_service</tt:XAddr></tt:PTZ>
   <tt:Analytics><tt:XAddr>http://192.168.1.64/onvif/analytics</tt:XAddr></tt:Analytics>
   <tt:System><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tt:System>
 </tds:Capabilities></tds:GetCapabilitiesResponse></s:Body></s:Envelope>"""

PROFILES = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
 <s:Body><trt:GetProfilesResponse>
  <trt:Profiles token="Profile_1" fixed="true">
    <tt:Name>mainStream</tt:Name>
    <tt:VideoEncoderConfiguration>
      <tt:Encoding>H264</tt:Encoding>
      <tt:Resolution><tt:Width>2560</tt:Width><tt:Height>1440</tt:Height></tt:Resolution>
      <tt:RateControl><tt:FrameRateLimit>25</tt:FrameRateLimit></tt:RateControl>
    </tt:VideoEncoderConfiguration>
    <tt:AudioEncoderConfiguration><tt:Name>audio</tt:Name></tt:AudioEncoderConfiguration>
    <tt:PTZConfiguration><tt:Name>ptz</tt:Name></tt:PTZConfiguration>
  </trt:Profiles>
  <trt:Profiles token="Profile_2" fixed="true">
    <tt:Name>subStream</tt:Name>
    <tt:VideoEncoderConfiguration>
      <tt:Encoding>H264</tt:Encoding>
      <tt:Resolution><tt:Width>640</tt:Width><tt:Height>360</tt:Height></tt:Resolution>
      <tt:RateControl><tt:FrameRateLimit>10</tt:FrameRateLimit></tt:RateControl>
    </tt:VideoEncoderConfiguration>
    <tt:MetadataConfiguration><tt:Name>meta</tt:Name></tt:MetadataConfiguration>
  </trt:Profiles>
 </trt:GetProfilesResponse></s:Body></s:Envelope>"""

STREAM_URI = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
 <s:Body><trt:GetStreamUriResponse><trt:MediaUri>
   <tt:Uri>rtsp://admin:hunter2@192.168.1.64:554/Streaming/Channels/102?transportmode=unicast</tt:Uri>
 </trt:MediaUri></trt:GetStreamUriResponse></s:Body></s:Envelope>"""

FAULT = """<?xml version="1.0"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><s:Fault>
 <s:Code><s:Value>s:Sender</s:Value></s:Code>
 <s:Reason><s:Text xml:lang="en">Sender not Authorized</s:Text></s:Reason>
</s:Fault></s:Body></s:Envelope>"""


def _transport(**overrides) -> SimulatedSoapTransport:
    responses = {
        "GetDeviceInformation": DEVICE_INFO,
        "GetCapabilities": CAPABILITIES,
        "GetProfiles": PROFILES,
        "GetStreamUri": STREAM_URI,
    }
    for key, value in overrides.items():
        if value is None:
            responses.pop(key, None)
        else:
            responses[key] = value
    return SimulatedSoapTransport(responses)


class DiscoveryTest(unittest.TestCase):
    def test_a_probe_match_yields_a_device_with_its_scopes(self):
        devices = OnvifDiscovery(
            SimulatedDiscoveryTransport([PROBE_MATCH]), now_iso=AT
        ).discover()
        self.assertEqual(len(devices), 1)
        device = devices[0]
        self.assertEqual(device.address, "http://192.168.1.64/onvif/device_service")
        self.assertEqual(device.model, "DS-2CD2143G2")
        self.assertIn("onvif://www.onvif.org/location/Lobby", device.scopes)

    def test_duplicate_responses_collapse_to_one_device(self):
        devices = OnvifDiscovery(
            SimulatedDiscoveryTransport([PROBE_MATCH, PROBE_MATCH]), now_iso=AT
        ).discover()
        self.assertEqual(len(devices), 1)

    def test_a_malformed_responder_is_skipped_not_fatal(self):
        # One hostile device on a VLAN must not stop an installer onboarding the other fifteen.
        devices = OnvifDiscovery(
            SimulatedDiscoveryTransport(["<not-xml", PROBE_MATCH]), now_iso=AT
        ).discover()
        self.assertEqual(len(devices), 1)

    def test_a_response_with_no_service_address_is_ignored(self):
        payload = PROBE_MATCH.replace("http://192.168.1.64/onvif/device_service", "")
        payload = payload.replace("<a:Address>urn:uuid:abc-123</a:Address>", "")
        devices = OnvifDiscovery(SimulatedDiscoveryTransport([payload]), now_iso=AT).discover()
        self.assertEqual(devices, [])


class NegotiationTest(unittest.TestCase):
    def _device(self, **overrides) -> DiscoveredDevice:
        return OnvifDevice(
            "http://192.168.1.64/onvif/device_service", _transport(**overrides), now_iso=AT
        ).negotiate()

    def test_it_learns_everything_the_architect_listed(self):
        d = self._device()
        self.assertEqual(d.manufacturer, "Hikvision")
        self.assertEqual(d.model, "DS-2CD2143G2")
        self.assertEqual(d.firmware, "V5.7.3")
        self.assertEqual(d.serial_number, "DS2CD00112233")
        self.assertEqual(d.onvif_version, "2.60")
        self.assertTrue(d.ptz)
        self.assertTrue(d.audio)
        self.assertTrue(d.metadata_stream)
        self.assertEqual(len(d.profiles), 2)
        self.assertEqual({p.codec for p in d.profiles}, {"h264"})
        self.assertEqual({p.resolution for p in d.profiles}, {"2560x1440", "640x360"})

    def test_the_media_service_address_is_used_for_media_calls(self):
        transport = _transport()
        OnvifDevice("http://192.168.1.64/onvif/device_service", transport, now_iso=AT).negotiate()
        media_calls = [url for url, name in transport.calls if name in ("GetProfiles", "GetStreamUri")]
        self.assertTrue(all(url.endswith("/media_service") for url in media_calls), media_calls)

    def test_the_sub_stream_is_chosen_for_analysis(self):
        d = self._device()
        chosen = [p for p in d.profiles if p.preferred_for_analysis]
        self.assertEqual([p.name for p in chosen], ["subStream"])

    def test_credentials_in_a_returned_stream_uri_are_stripped_to_a_path(self):
        """Real devices routinely hand back a URI with the password already in it. Storing that would
        put a camera password into the camera record — exactly what `credentialRef` exists to prevent."""
        d = self._device()
        for profile in d.profiles:
            self.assertIsNotNone(profile.path)
            self.assertNotIn("hunter2", profile.path)
            self.assertNotIn("@", profile.path)
            self.assertTrue(profile.path.startswith("/"))
        self.assertEqual(d.profiles[1].path, "/Streaming/Channels/102?transportmode=unicast")

    def test_a_device_that_refuses_getcapabilities_still_negotiates(self):
        # Plenty of working devices answer GetProfiles and nothing else. Optional services must
        # degrade to a negative capability, never to an exception.
        d = self._device(GetCapabilities=None)
        self.assertEqual(len(d.profiles), 2)
        self.assertTrue(d.ptz)  # inferred from the profile's PTZConfiguration instead
        self.assertIsNone(d.onvif_version)

    def test_a_device_that_refuses_getdeviceinformation_still_negotiates(self):
        d = self._device(GetDeviceInformation=None)
        self.assertIsNone(d.manufacturer)
        self.assertEqual(len(d.profiles), 2)

    def test_a_device_with_no_profiles_raises(self):
        # Without profiles there is nothing to configure; producing a camera record that cannot
        # stream would be worse than failing.
        empty = PROFILES.replace(PROFILES[PROFILES.index("<trt:Profiles"):PROFILES.index("</trt:GetProfilesResponse>")], "")
        with self.assertRaises(OnvifError):
            self._device(GetProfiles=empty)

    def test_an_authentication_fault_is_reported_as_onvif_not_connection(self):
        # A device refusing credentials is an operator problem, not something the reconnect
        # supervisor should retry forever.
        with self.assertRaises(OnvifError) as ctx:
            self._device(GetProfiles=FAULT)
        self.assertIn("Sender not Authorized", str(ctx.exception))


class ContractProjectionTest(unittest.TestCase):
    def setUp(self):
        self.device = OnvifDevice(
            "http://192.168.1.64/onvif/device_service", _transport(), now_iso=AT
        ).negotiate()

    def test_capabilities_project_onto_the_camera_contract(self):
        caps = self.device.to_capabilities()
        self.assertTrue(caps["onvif"])
        self.assertTrue(caps["ptz"])
        self.assertTrue(caps["metadataStream"])
        self.assertEqual(caps["codecs"], ["h264"])
        self.assertEqual(caps["protocols"], ["rtsp"])
        self.assertEqual(caps["fpsRange"], {"min": 10, "max": 25})
        self.assertEqual(caps["discoveredAt"], AT())
        self.assertEqual(
            [p["name"] for p in caps["streamProfiles"] if p["preferredForAnalysis"]], ["subStream"]
        )

    def test_metadata_projects_onto_the_camera_contract(self):
        meta = self.device.to_metadata()
        self.assertEqual(meta["manufacturer"], "Hikvision")
        self.assertEqual(meta["firmware"], "V5.7.3")
        self.assertEqual(meta["tags"], [])

    def test_the_registry_slug_is_stable_and_filesystem_safe(self):
        self.assertEqual(self.device.registry_id, "hikvision-ds-2cd2143g2")


class ProfileSelectionTest(unittest.TestCase):
    def test_smallest_above_the_analysis_floor_wins(self):
        profiles = [
            StreamProfile(name="main", width=1920, height=1080),
            StreamProfile(name="sub", width=640, height=360),
            StreamProfile(name="mid", width=1280, height=720),
        ]
        self.assertEqual(select_analysis_profile(profiles).name, "sub")

    def test_a_stream_below_the_floor_is_not_chosen_over_a_usable_one(self):
        # Going too small costs detection recall, and then the cheap stream stops being a saving.
        profiles = [
            StreamProfile(name="tiny", width=320, height=180),
            StreamProfile(name="sub", width=640, height=360),
        ]
        self.assertEqual(select_analysis_profile(profiles).name, "sub")

    def test_a_device_with_only_tiny_streams_analyzes_its_best_one(self):
        profiles = [
            StreamProfile(name="tiny", width=320, height=180),
            StreamProfile(name="tinier", width=176, height=144),
        ]
        self.assertEqual(select_analysis_profile(profiles).name, "tiny")

    def test_selection_is_exclusive(self):
        profiles = [
            StreamProfile(name="a", width=1920, height=1080, preferred_for_analysis=True),
            StreamProfile(name="b", width=640, height=360),
        ]
        select_analysis_profile(profiles)
        self.assertEqual([p.name for p in profiles if p.preferred_for_analysis], ["b"])

    def test_profiles_with_no_resolution_are_not_selectable(self):
        self.assertIsNone(select_analysis_profile([StreamProfile(name="unknown")]))


class SecurityTest(unittest.TestCase):
    def test_the_password_never_appears_in_the_soap_envelope(self):
        """ONVIF is routinely spoken over plain HTTP inside a customer LAN. A plaintext token would
        put a camera password on the wire in cleartext, so the envelope carries only a SHA-1 digest."""
        transport = _transport()
        OnvifDevice(
            "http://192.168.1.64/onvif/device_service",
            transport,
            username="admin",
            password="hunter2",
            now_iso=AT,
        ).negotiate()
        # Re-drive one call and capture the envelope the transport was handed.
        captured = []

        class _Capturing(SimulatedSoapTransport):
            def call(self, url, envelope, *, action, timeout_seconds=5.0):
                captured.append(envelope)
                return super().call(url, envelope, action=action, timeout_seconds=timeout_seconds)

        OnvifDevice(
            "http://192.168.1.64/onvif/device_service",
            _Capturing(
                {
                    "GetDeviceInformation": DEVICE_INFO,
                    "GetCapabilities": CAPABILITIES,
                    "GetProfiles": PROFILES,
                    "GetStreamUri": STREAM_URI,
                }
            ),
            username="admin",
            password="hunter2",
            now_iso=AT,
        ).negotiate()
        self.assertTrue(captured)
        for envelope in captured:
            self.assertNotIn("hunter2", envelope)
            self.assertIn("PasswordDigest", envelope)
            self.assertIn("<Username>admin</Username>", envelope)

    def test_no_security_header_is_sent_without_credentials(self):
        captured = []

        class _Capturing(SimulatedSoapTransport):
            def call(self, url, envelope, *, action, timeout_seconds=5.0):
                captured.append(envelope)
                return super().call(url, envelope, action=action, timeout_seconds=timeout_seconds)

        OnvifDevice(
            "http://192.168.1.64/onvif/device_service",
            _Capturing({"GetProfiles": PROFILES, "GetStreamUri": STREAM_URI}),
            now_iso=AT,
        ).negotiate()
        self.assertTrue(all("Security" not in e for e in captured))


if __name__ == "__main__":
    unittest.main()
