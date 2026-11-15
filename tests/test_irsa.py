from __future__ import annotations

import asyncio

import pytest

from backend.services.irsa import IRSAIncompatibleSchemaError, IRSAService


def test_searches_all_current_spherex_sia2_collections(monkeypatch):
    service = IRSAService()
    calls = []

    async def fake_query(collection, ra, dec, radius, limit):
        calls.append((collection, ra, dec, radius, limit))
        return [{
            "obs_id": collection,
            "access_url": f"https://irsa.ipac.caltech.edu/{collection}.fits",
            "s_ra": ra,
            "s_dec": dec,
            "t_min": 61000,
        }]

    monkeypatch.setattr(service, "_query_collection", fake_query)
    result = asyncio.run(service.query_observations(150.1, 2.2, 0.5, 10))

    assert result["is_demo"] is False
    assert result["count"] == 4
    assert set(result["query"]["collections"]) == set(service.COLLECTIONS)
    assert {call[0] for call in calls} == set(service.COLLECTIONS)
    assert all(call[1:] == (150.1, 2.2, 0.5, 10) for call in calls)
    assert "DR1 + QR3" in result["source"]


def test_partial_collection_failure_does_not_hide_valid_results(monkeypatch):
    service = IRSAService()

    async def fake_query(collection, *_args):
        if collection == service.COLLECTIONS[0]:
            raise RuntimeError("temporary failure")
        return [{"obs_id": collection, "access_url": f"https://irsa.ipac.caltech.edu/{collection}.fits"}]

    monkeypatch.setattr(service, "_query_collection", fake_query)
    result = asyncio.run(service.query_observations(10, -2, 0.2, 20))

    assert result["count"] == 3
    assert len(result["warnings"]) == 1


def test_all_collection_failures_raise_irsa_error(monkeypatch):
    service = IRSAService()

    async def fail(*_args):
        raise OSError("offline")

    monkeypatch.setattr(service, "_query_collection", fail)
    with pytest.raises(Exception):
        asyncio.run(service.query_observations(10, -2, 0.2, 20))


def test_invalid_coordinates_are_rejected_before_network(monkeypatch):
    service = IRSAService()

    async def unexpected_call(*_args):
        raise AssertionError("SIA2 must not be called for invalid coordinates")

    monkeypatch.setattr(service, "_query_collection", unexpected_call)
    with pytest.raises(ValueError):
        asyncio.run(service.query_observations(361, 0, 1))


def test_json_table_rows_are_normalized(monkeypatch):
    service = IRSAService()

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "metadata": [{"name": "access_url"}, {"name": "s_ra"}],
                "data": [["https://irsa.ipac.caltech.edu/a.fits", 12.5]],
            }

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr("backend.services.irsa.httpx.AsyncClient", FakeClient)
    rows = asyncio.run(service._query_collection("spherex_dr1", 12, 1, 0.1, 10))
    assert rows == [{"access_url": "https://irsa.ipac.caltech.edu/a.fits", "s_ra": 12.5}]


def test_unsupported_json_schema_is_rejected(monkeypatch):
    service = IRSAService()

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"unexpected": "payload"}

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def get(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr("backend.services.irsa.httpx.AsyncClient", FakeClient)
    with pytest.raises(IRSAIncompatibleSchemaError):
        asyncio.run(service._query_collection("spherex_dr1", 12, 1, 0.1, 10))
