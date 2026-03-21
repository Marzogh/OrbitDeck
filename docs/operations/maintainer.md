# Maintainer Guide

## Repo hygiene

Keep the public repo focused on shippable product files.

Do not track:

- runtime state under `data/state.json`
- cached snapshots under `data/snapshots/`
- internal proposal and review logs under `docs/*proposal*.md`, `docs/*review-log.md`, and `docs/*redesign-log.md`
- generated MkDocs output under `site/`

## Documentation rule

When product behavior changes, update both:

- `README.md`
- `docs/INSTALL_AND_RUN.md`

If the change affects the docs site structure or quick-start workflow, update the relevant MkDocs pages too.

## Useful validation

Backend:

```bash
pytest -q
```

Frontend syntax checks:

```bash
node --check app/static/lite/lite.js
node --check app/static/lite/sw.js
node --check app/static/kiosk/rotator.js
```

Docs build:

```bash
mkdocs build --strict
```

## Beginner-doc standard

When adding or changing product docs, aim for both of these at the same time:

- clear enough that installation and first use do not require reading source code
- detailed enough that an advanced user can understand the actual runtime and API behavior

If a page only lists routes or only describes broad marketing behavior, it is probably not detailed enough yet.
