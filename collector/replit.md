# Running Scrabeee on Replit

This is a command-line collector, not a web server. Use Python 3.11 or newer.

1. Install dependencies with `python -m pip install -r requirements.txt`.
2. Copy `.env.example` to `.env` and edit queries/locations as needed.
3. Run `python main.py --init-db` to create the local SQLite database.
4. Run `python main.py` to fetch and persist one collection cycle.

The Replit console workflow runs one cycle when started. Hourly automation is
provided by `../.github/workflows/collector.yml`; use a persistent PostgreSQL
`DATABASE_URL` secret in GitHub Actions to preserve records across scheduled
runs. An Actions runner's default SQLite file is temporary.
