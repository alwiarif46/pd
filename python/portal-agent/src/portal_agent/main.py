"""Entry point: `uv run portal-agent`."""

import os

import uvicorn

DEFAULT_PORT = 4112


def main() -> None:
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    uvicorn.run("portal_agent.app:app", host="0.0.0.0", port=port)  # noqa: S104 - container service


if __name__ == "__main__":
    main()
