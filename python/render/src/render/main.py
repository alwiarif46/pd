"""Entry point: `uv run render`."""

import os

import uvicorn

DEFAULT_PORT = 4109


def main() -> None:
    port = int(os.environ.get("PORT") or DEFAULT_PORT)
    uvicorn.run("render.app:app", host="0.0.0.0", port=port)  # noqa: S104 - container service


if __name__ == "__main__":
    main()
