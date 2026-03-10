# Documentation Contributing Guide

Use the OrbitDeck docs site for stable operator and contributor guidance.

## Expectations

- keep `README.md` and `docs/INSTALL_AND_RUN.md` aligned
- prefer documenting current product behavior rather than aspirational behavior
- do not turn internal design notes into published docs pages
- keep route names and settings names synchronized with `app/main.py` and `app/models.py`

## Before opening a docs change

1. Check the current route surface in `app/main.py`.
2. Check settings models in `app/models.py`.
3. Build the docs locally with `mkdocs build --strict`.

## Keep out of the docs site

- internal review logs
- redesign scratch notes
- local runtime artifacts
