#!/usr/bin/env python3
"""Health check for the local `stock_data` Postgres database.

Thin entry point — everything lives in the db_health package. Drop this file
next to update_stock_data.py and run it there.

    python db_health_check.py --help
    python db_health_check.py --profile quick
    python db_health_check.py --universe all_us --format markdown
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db_health.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
