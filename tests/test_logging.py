"""Tests for structured JSON logging."""

import json
import logging

from atlasent.logging import JSONFormatter, configure_logging


class TestJSONFormatter:
    def test_formats_as_json(self):
        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="atlasent",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="evaluate permitted",
            args=(),
            exc_info=None,
        )
        output = formatter.format(record)
        data = json.loads(output)
        assert data["level"] == "INFO"
        assert data["logger"] == "atlasent"
        assert data["message"] == "evaluate permitted"
        assert "timestamp" in data

    def test_includes_extra_fields(self):
        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="atlasent",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="test",
            args=(),
            exc_info=None,
        )
        record.action_type = "read_data"
        record.actor_id = "agent-1"
        record.permit_token = "dec_100"
        record.request_id = "abc123"
        output = formatter.format(record)
        data = json.loads(output)
        assert data["action_type"] == "read_data"
        assert data["actor_id"] == "agent-1"
        assert data["permit_token"] == "dec_100"
        assert data["request_id"] == "abc123"

    def test_omits_absent_extras(self):
        formatter = JSONFormatter()
        record = logging.LogRecord(
            name="atlasent",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="test",
            args=(),
            exc_info=None,
        )
        output = formatter.format(record)
        data = json.loads(output)
        assert "action_type" not in data
        assert "request_id" not in data


class TestConfigureLogging:
    def test_sets_level(self):
        logger = configure_logging("DEBUG")
        assert logger.level == logging.DEBUG
        assert logger.name == "atlasent"

    def test_adds_json_handler(self):
        logger = configure_logging("INFO")
        assert len(logger.handlers) == 1
        assert isinstance(logger.handlers[0].formatter, JSONFormatter)

    def test_no_duplicate_handlers(self):
        configure_logging("INFO")
        configure_logging("DEBUG")
        logger = logging.getLogger("atlasent")
        assert len(logger.handlers) == 1

    def test_accepts_int_level(self):
        logger = configure_logging(logging.WARNING)
        assert logger.level == logging.WARNING
