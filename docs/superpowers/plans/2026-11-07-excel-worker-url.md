# Excel worker loader fix

Root cause: the production client transform serializes import.meta.url as a build-machine file URL inside the Worker URL constructor. Unit tests and direct worker bundle execution bypassed the parent browser loader.

1. Execute the emitted parent loader with a fake Worker in an HTTPS module context; reproduce file-protocol failure.
2. Replace the source URL constructor with a lazily imported Vite ?worker factory, retaining the Node fallback.
3. Build production and run the same artifact check, including resource existence, module options and a completed message exchange.
4. Run existing Excel import, archive, chunk and persistence tests, types and lint, then publish and sync the private repository.
