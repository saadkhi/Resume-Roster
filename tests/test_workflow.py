from pathlib import Path


def test_github_actions_workflow_has_hourly_and_manual_triggers():
    workflow = Path(".github/workflows/scraper.yml").read_text(encoding="utf-8")
    assert 'cron: "0 * * * *"' in workflow
    assert "workflow_dispatch:" in workflow
    assert "timeout-minutes: 45" in workflow
    assert "cancel-in-progress: false" in workflow
    assert "pytest" in workflow
    assert "ruff check ." in workflow
