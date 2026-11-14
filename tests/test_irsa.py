"""Tests for the live-only IRSA integration. Network responses are mocked here."""
import asyncio

import httpx
import pytest

from backend.services.irsa import (
    IRSAConnectionError,
    IRSAIncompatibleSchemaError,
    IRSASerivce,
)