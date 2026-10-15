from pathlib import Path


def test_github_actions_workflow_runs_twice_daily_and_supports_manual_dispatch():
    workflow = Path(".github/workflows/scraper.yml").read_text(encoding="utf-8")
    assert 'cron: "0 7,19 * * *"' in workflow
    assert "12:00 PM and 12:00 AM Asia/Karachi" in workflow
    assert "workflow_dispatch:" in workflow
    assert "timeout-minutes: 45" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "pytest" in workflow
    assert "ruff check ." in workflow
