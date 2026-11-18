import argparse

from app.main import run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--no-browser", action="store_true")
    args, _ = parser.parse_known_args()
    run(open_browser=not args.no_browser)

