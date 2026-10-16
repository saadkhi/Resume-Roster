"""SQLAlchemy persistence layer for jobs and source execution history."""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    func,
    or_,
    select,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from config import load_config
from utils.fingerprints import generate_unique_hash

_engine = None
_session_factory: sessionmaker[Session] | None = None


class UTCDateTime(TypeDecorator[datetime]):
    """Store UTC datetimes consistently, including on SQLite."""

    impl = DateTime
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        return dialect.type_descriptor(DateTime(timezone=True))

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        value = value.astimezone(timezone.utc)
        # SQLite has no timezone-aware datetime storage.
        if dialect.name == "sqlite":
            return value.replace(tzinfo=None)
        return value

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)


class Base(DeclarativeBase):
    pass


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_site", "site"),
        Index("ix_jobs_date_posted", "date_posted"),
        Index("ix_jobs_first_seen_at", "first_seen_at"),
        Index("ix_jobs_workplace_type", "workplace_type"),
    )

    unique_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    job_id: Mapped[str | None] = mapped_column(String(255))
    site: Mapped[str] = mapped_column(String(100), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    company: Mapped[str] = mapped_column(String(500), nullable=False)
    location: Mapped[str | None] = mapped_column(String(500))
    job_type: Mapped[str] = mapped_column(String(50), default="unknown", nullable=False)
    is_remote: Mapped[bool | None] = mapped_column(Boolean)
    workplace_type: Mapped[str] = mapped_column(String(50), default="unknown", nullable=False)
    job_url: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    min_amount: Mapped[float | None] = mapped_column(Float)
    max_amount: Mapped[float | None] = mapped_column(Float)
    currency: Mapped[str | None] = mapped_column(String(8))
    salary_period: Mapped[str] = mapped_column(String(50), default="unknown", nullable=False)
    date_posted: Mapped[datetime | None] = mapped_column(UTCDateTime())
    first_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    tags: Mapped[str | None] = mapped_column(Text)


class SourceRun(Base):
    __tablename__ = "source_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    source_name: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    fetched_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    inserted_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    duplicate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_summary: Mapped[str | None] = mapped_column(Text)


def init_db(database_url: str | None = None) -> None:
    """Create the engine and any missing tables."""
    global _engine, _session_factory
    url = database_url or load_config().database_url
    kwargs: dict[str, Any] = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    _engine = create_engine(url, **kwargs)
    _session_factory = sessionmaker(bind=_engine, expire_on_commit=False)
    Base.metadata.create_all(_engine)


def get_session() -> Session:
    if _session_factory is None:
        init_db()
    assert _session_factory is not None
    return _session_factory()


def _clean_value(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, pd.Timestamp):
        return value.to_pydatetime()
    return value


def is_duplicate(unique_hash: str, session: Session | None = None) -> bool:
    owns_session = session is None
    active = session or get_session()
    try:
        return active.get(Job, unique_hash) is not None
    finally:
        if owns_session:
            active.close()


def update_existing_job(
    job: dict[str, Any], session: Session | None = None, current: Job | None = None
) -> bool:
    """Update mutable vacancy data without changing its first-seen timestamp."""
    owns_session = session is None
    active = session or get_session()
    try:
        existing = current or active.get(Job, job["unique_hash"])
        if existing is None:
            return False
        changed = False
        for key in (
            "job_id",
            "site",
            "title",
            "company",
            "location",
            "job_type",
            "is_remote",
            "workplace_type",
            "job_url",
            "description",
            "min_amount",
            "max_amount",
            "currency",
            "salary_period",
            "date_posted",
            "tags",
        ):
            if key in job:
                value = _clean_value(job[key])
                if getattr(existing, key) != value:
                    setattr(existing, key, value)
                    changed = True
        observed = _clean_value(job.get("last_seen_at")) or datetime.now(timezone.utc)
        existing.last_seen_at = observed
        if changed:
            existing.updated_at = _clean_value(job.get("updated_at")) or observed
        if owns_session:
            active.commit()
        return changed
    except Exception:
        if owns_session:
            active.rollback()
        raise
    finally:
        if owns_session:
            active.close()


def bulk_insert_jobs(jobs_df: pd.DataFrame | list[dict[str, Any]]) -> dict[str, int]:
    """Insert or update a batch in one transaction; uniqueness is DB-enforced."""
    rows = jobs_df.to_dict(orient="records") if isinstance(jobs_df, pd.DataFrame) else jobs_df
    counts = {"inserted": 0, "updated": 0, "duplicate": 0, "rejected": 0}
    session = get_session()
    try:
        for raw in rows:
            row = {key: _clean_value(value) for key, value in dict(raw).items()}
            if not row.get("unique_hash"):
                row["unique_hash"] = generate_unique_hash(row)
            required = ("site", "title", "company", "job_url")
            if any(not row.get(key) for key in required):
                counts["rejected"] += 1
                continue
            existing = session.get(Job, row["unique_hash"])
            if existing:
                changed = update_existing_job(row, session, existing)
                counts["duplicate"] += 1
                counts["updated"] += int(changed)
                continue
            now = datetime.now(timezone.utc)
            row.setdefault("first_seen_at", now)
            row.setdefault("last_seen_at", now)
            row.setdefault("created_at", now)
            row.setdefault("updated_at", now)
            row.setdefault("job_type", "unknown")
            row.setdefault("workplace_type", "unknown")
            row.setdefault("salary_period", "unknown")
            allowed = {column.key for column in Job.__table__.columns}
            job = Job(**{key: value for key, value in row.items() if key in allowed})
            try:
                with session.begin_nested():
                    session.add(job)
                    session.flush()
                counts["inserted"] += 1
            except IntegrityError:
                concurrent = session.get(Job, row["unique_hash"])
                if concurrent is None:
                    raise
                update_existing_job(row, session, concurrent)
                counts["duplicate"] += 1
                counts["updated"] += 1
        session.commit()
        return counts
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_job_count() -> int:
    with get_session() as session:
        return int(session.scalar(select(func.count()).select_from(Job)) or 0)


def get_latest_jobs(limit: int | None = 100) -> list[Job]:
    with get_session() as session:
        statement = select(Job).order_by(Job.first_seen_at.desc())
        if limit is not None:
            statement = statement.limit(limit)
        return list(session.scalars(statement).all())


def get_source_runs(limit: int = 500) -> list[SourceRun]:
    with get_session() as session:
        return list(
            session.scalars(select(SourceRun).order_by(SourceRun.id.desc()).limit(limit)).all()
        )


def record_source_run(
    *,
    run_id: str,
    source_name: str,
    started_at: datetime,
    finished_at: datetime | None,
    status: str,
    fetched_count: int = 0,
    inserted_count: int = 0,
    duplicate_count: int = 0,
    rejected_count: int = 0,
    error_count: int = 0,
    error_summary: str | None = None,
) -> None:
    with get_session() as session:
        session.add(
            SourceRun(
                run_id=run_id,
                source_name=source_name,
                started_at=started_at,
                finished_at=finished_at,
                status=status,
                fetched_count=fetched_count,
                inserted_count=inserted_count,
                duplicate_count=duplicate_count,
                rejected_count=rejected_count,
                error_count=error_count,
                error_summary=error_summary,
            )
        )
        session.commit()


_LIKE_ESCAPE = chr(92)


def _escape_like(value: str) -> str:
    return (
        value.replace(_LIKE_ESCAPE, _LIKE_ESCAPE + _LIKE_ESCAPE)
        .replace("%", _LIKE_ESCAPE + "%")
        .replace("_", _LIKE_ESCAPE + "_")
    )


def query_jobs(
    *,
    q: str | None = None,
    location: str | None = None,
    site: str | None = None,
    job_type: str | None = None,
    workplace_type: str | None = None,
    is_remote: bool | None = None,
    posted_within_hours: int | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[int, list[Job]]:
    """Return (total matches, page of jobs), newest first by posting or first-seen time."""
    effective_date = func.coalesce(Job.date_posted, Job.first_seen_at)
    conditions = []
    if q:
        pattern = f"%{_escape_like(q.strip())}%"
        conditions.append(
            or_(
                *(
                    column.ilike(pattern, escape=_LIKE_ESCAPE)
                    for column in (Job.title, Job.company, Job.description, Job.tags)
                )
            )
        )
    if location:
        conditions.append(
            Job.location.ilike(f"%{_escape_like(location.strip())}%", escape=_LIKE_ESCAPE)
        )
    if site:
        conditions.append(func.lower(Job.site) == site.strip().lower())
    if job_type:
        conditions.append(func.lower(Job.job_type) == job_type.strip().lower())
    if workplace_type:
        conditions.append(func.lower(Job.workplace_type) == workplace_type.strip().lower())
    if is_remote is not None:
        conditions.append(Job.is_remote.is_(is_remote))
    if posted_within_hours:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=posted_within_hours)
        conditions.append(effective_date >= cutoff)
    with get_session() as session:
        total = session.scalar(select(func.count()).select_from(Job).where(*conditions)) or 0
        rows = session.scalars(
            select(Job)
            .where(*conditions)
            .order_by(effective_date.desc(), Job.unique_hash)
            .limit(limit)
            .offset(offset)
        ).all()
        return int(total), list(rows)


def get_job(unique_hash: str) -> Job | None:
    with get_session() as session:
        return session.get(Job, unique_hash)


def get_site_counts() -> list[tuple[str, int]]:
    with get_session() as session:
        rows = session.execute(
            select(Job.site, func.count()).group_by(Job.site).order_by(func.count().desc())
        ).all()
        return [(site, int(count)) for site, count in rows]
