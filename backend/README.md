# backend

Python service. The installer provisions the interpreter and `uv`; it does not
yet create the environment or install dependencies — that will be a later
installer step (`60-setup-app.sh`).

Manual setup for now:

    uv venv .venv
    . .venv/bin/activate
    uv pip install -r requirements.txt   # once dependencies exist

The system Python is externally managed (PEP 668), so a venv is mandatory —
global `pip install` will be refused.
