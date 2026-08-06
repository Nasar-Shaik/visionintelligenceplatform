# Customer workflows

**The customer-facing reference architecture.** One document per capability, describing what the
platform does for a customer's business problem — not how the code is organised.

| Document                                     | Capability                                                                                     | Status                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| [Retail-Loitering.md](./Retail-Loitering.md) | **Retail Loitering** — the first complete customer workflow                                    | production-verified, pending freeze |
| [VERTICALS.md](./VERTICALS.md)               | How the same pipeline serves retail, hospital, manufacturing, warehouse, education and traffic | capability map                      |

---

## What belongs here, and what does not

**Here:** the business problem, the flow through the platform in the customer's vocabulary, what an
operator is expected to do, what the capability cannot do, and what it would take to extend it.

**Not here:** implementation. A workflow document that explains the code is an architecture document
with the wrong audience, and it goes stale the first time somebody refactors. The decisions live in
[`docs/adr/`](../adr/); the state of the build lives in
[PRODUCT_CAPABILITY_MATRIX](../project/PRODUCT_CAPABILITY_MATRIX.md).

## ⚠️ Three rules for anything written here

1. **Every number is measured.** If a figure appears, a verification produced it, and the document
   says which. A projected number in a customer-facing document becomes a commitment the moment
   somebody reads it aloud.
2. **Limitations are in the same document as the capability**, not in an appendix and not in a
   separate file the reader will not open. A limitation a customer discovers after purchase was
   hidden, however carefully it was written down elsewhere.
3. **The word "supports" needs a verification behind it.** ✅ in the capability matrix means someone
   did it against a deployment and it worked. This directory inherits that standard.
