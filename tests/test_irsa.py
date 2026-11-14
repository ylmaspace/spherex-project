from __future__ import annotations

import asyncio

import pytest

from backend.services.irsa import (
    IRSAIncompatibleSchemaError,
    IRSATableNotFoundError,
    IRSAService,
    ObservationNotFoundError,
)


def test_discovers_supported_obscore_table_and_columns(monkeypatch):
    service = IRSAService()
    calls = []

    async def fake_tap(adql):
        calls.append(adql)
        if "TAP_SCHEMA.tables" in adql:
            return [{"schema_name": "spherex", "table_name": "obscore"}]
        return [
            {"column_name": "s_ra"},
            {"column_name": "s_dec"},
            {"column_name": "obs_id"},
            {"column_name": "t_min"},
        ]

    monkeypatch.setattr(service, "_tap", fake_tap)
    schema, table, columns = asyncio.run(service._discover_table())

    assert (schema, table) == ("spherex", "obscore")
    assert {"s_ra", "s_dec", "obs_id", "t_min"} <= columns
    assert len(calls) == 2


def test_missing_table_is_not_silently_replaced_with_demo(monkeypatch):
    service = IRSAService()

    async def fake_tap(_adql):
        return []

    monkeypatch.setattr(service, "_tap", fake_tap)
    with pytest.raises(IRSATableNotFoundError):
        asyncio.run(service._discover_table())
    assert service.demo_mode is False


def test_incompatible_table_schema_is_rejected(monkeypatch):
    service = IRSAService()

    async def fake_tap(adql):
        if "TAP_SCHEMA.tables" in adql:
            return [{"schema_name": "spherex", "table_name": "obscore"}]
        return [{"column_name": "obs_id"}]

    monkeypatch.setattr(service, "_tap", fake_tap)
    with pytest.raises(IRSAIncompatibleSchemaError):
        asyncio.run(service._discover_table())


def test_query_uses_discovered_table_and_real_result_rows(monkeypatch):
    service = IRSAService()
    calls = []

    async def fake_tap(adql):
        calls.append(adql)
        if "TAP_SCHEMA.tables" in adql:
            return [{"schema_name": "spherex", "table_name": "obscore"}]
        if "TAP_SCHEMA.columns" in adql:
            return [
                {"column_name": "s_ra"},
                {"column_name": "s_dec"},
                {"column_name": "t_min"},
            ]
        return [{"s_ra": 150.1, "s_dec": 2.2, "t_min": 61000.0}]

    monkeypatch.setattr(service, "_tap", fake_tap)
    result = asyncio.run(service.query_observations(150.1, 2.2, 0.5, 10))

    assert result["is_demo"] is False
    assert result["count"] == 1
    assert result["observations"][0]["s_ra"] == 150.1
    assert "FROM spherex.obscore" in calls[-1]
    assert "CONTAINS(POINT" in calls[-1]


def test_invalid_coordinates_are_rejected_before_network(monkeypatch):
    service = IRSAService()

    async def unexpected_call(_adql):
        raise AssertionError("TAP must not be called for invalid coordinates")

    monkeypatch.setattr(service, "_tap", unexpected_call)
    with pytest.raises(ValueError):
        asyncio.run(service.query_observations(361, 0, 1))


def test_missing_observation_returns_not_found(monkeypatch):
    service = IRSAService()

    async def fake_tap(adql):
        if "TAP_SCHEMA.tables" in adql:
            return [{"schema_name": "spherex", "table_name": "obscore"}]
        if "TAP_SCHEMA.columns" in adql:
            return [{"column_name": "s_ra"}, {"column_name": "s_dec"}, {"column_name": "obs_id"}]
        return []

    monkeypatch.setattr(service, "_tap", fake_tap)
    with pytest.raises(ObservationNotFoundError):
        asyncio.run(service.get_observation_detail("missing-id"))
