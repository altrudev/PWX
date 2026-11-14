# PWX: Progressive Web eXecutable

PWX is a signed, self-contained web app package that runs in any modern browser and can
only do what its manifest declares. Anyone can verify the code, and the runtime enforces
the declared limits instead of relying on the publisher's promise.

## Status

Early design. The working specification is **PWX Specification v0 (Draft)**, kept as a
shared doc for now; it will move into this repo as it stabilizes.

## Branches

| Branch | Contents |
| --- | --- |
| `main` | Project overview; the spec and stable code land here |
| `spike` | Week-one spike: verifier, packer, loader and the cross-browser leak tests (`spike/`) |

## License

Apache-2.0 (proposed).
