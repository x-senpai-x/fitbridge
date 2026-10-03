"""Writes Life Dashboard Companion and HC Webhook fixture payloads.

Key order and field names follow the serializers:
  LDC: HealthSyncManager.buildJsonPayload, DeletionTracking.payloadFields (1.21.2 / fc8e0a8)
  HCW: SyncManager.buildJsonPayload + putRecordMetadata (v1.9.22 / a61de8f)
Values marked REAL come from public issue reports (LDC #53, #71, #73); everything else is
illustrative. No file here is a captured payload.
"""

import hashlib
import hmac
import json
from pathlib import Path

OUT = Path(__file__).parent
FITBIT = "com.fitbit.FitbitMobile"
SLEEP_UUID = "8e6d489e-dcc4-3262-b782-33c17349a891"  # REAL, LDC #71 (v3 uuid from clientRecordId)
HR_RECORD = "5b0c7a2e-1f3d-3c41-9a7e-2d4f6b8c0e11"
TEST_SECRET = "3f9a1c0e5b7d2e4f6a8c0b1d3e5f7a9c2b4d6e8f0a1c3e5b7d9f1a2c4e6b8d0f"


def ms(iso):
    from datetime import datetime
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)


def diag(raw, filtered, raw_min, raw_max, raw_mod, mn, mx, last_sync, read_from, pages=1):
    return {
        "permission_granted": True, "page_count": pages, "raw_record_count": raw,
        "raw_min_time": raw_min, "raw_max_time": raw_max, "raw_latest_modified_time": raw_mod,
        "filtered_record_count": filtered, "min_time": mn, "max_time": mx,
        "last_sync": last_sync, "error": None, "own_records_skipped": 0,
        "read_from": read_from, "lookback_gap_from": None,
    }


def hr(bpm, t):
    return {"bpm": bpm, "time": t, "uuid": f"{HR_RECORD}#{ms(t)}", "source": FITBIT}


sync = {
    "timestamp": "2026-09-23T05:48:12.431Z",
    "app_version": "1.21.2",
    "source": "health_connect",
    "sequence": 1066,  # REAL number from LDC #71
    "daily_totals": [
        {"date": "2026-09-21", "steps": 9412, "distance_meters": 7034.2, "total_calories": 2917.4},
        {"date": "2026-09-22", "steps": 11873, "distance_meters": 8890.6, "total_calories": 3085.1},
        {"date": "2026-09-23", "steps": 214, "distance_meters": 160.3, "total_calories": 452.8},
    ],
    "steps": [
        {"count": 38, "start_time": "2026-09-23T05:31:00Z", "end_time": "2026-09-23T05:32:00Z",
         "uuid": "c2a6e0f4-8b1d-3e57-a9c3-5d7f1b3e9a20", "source": FITBIT},
        {"count": 112, "start_time": "2026-09-23T05:32:00Z", "end_time": "2026-09-23T05:33:00Z",
         "uuid": "0e4b8d2f-6a1c-3f95-b7d1-3a5c7e9f1b42", "source": FITBIT},
    ],
    "sleep": [
        {
            "session_end_time": "2026-09-23T04:42:00Z",  # REAL, LDC #71
            "duration_seconds": 24060,  # REAL, LDC #71 (start 2026-09-22T22:01:00Z)
            "uuid": SLEEP_UUID,
            "source": FITBIT,
            "stages": [
                {"stage": "awake", "start_time": "2026-09-22T22:01:00Z", "end_time": "2026-09-22T22:09:30Z", "duration_seconds": 510},
                {"stage": "light", "start_time": "2026-09-22T22:09:30Z", "end_time": "2026-09-22T23:02:00Z", "duration_seconds": 3150},
                {"stage": "deep", "start_time": "2026-09-22T23:02:00Z", "end_time": "2026-09-22T23:48:30Z", "duration_seconds": 2790},
                {"stage": "rem", "start_time": "2026-09-22T23:48:30Z", "end_time": "2026-09-23T00:11:00Z", "duration_seconds": 1350},
                {"stage": "light", "start_time": "2026-09-23T00:11:00Z", "end_time": "2026-09-23T04:42:00Z", "duration_seconds": 16260},
            ],
        }
    ],
    "heart_rate": [
        hr(61, "2026-09-23T05:30:02Z"),
        hr(63, "2026-09-23T05:30:07Z"),
        hr(66, "2026-09-23T05:30:12Z"),
    ],
    "distance": [
        {"meters": 28.4, "start_time": "2026-09-23T05:31:00Z", "end_time": "2026-09-23T05:32:00Z",
         "uuid": "9d3f5b7a-2c4e-3618-8a0b-4c6e8a0c2e64", "source": FITBIT},
    ],
    "total_calories": [
        {"calories": 1.27, "start_time": "2026-09-23T03:53:00Z", "end_time": "2026-09-23T03:54:00Z",  # minute shape REAL, LDC #73
         "uuid": "71a3c5e7-9b2d-3f40-8c6e-0a2c4e6a8c86", "source": FITBIT},
        {"calories": 1.27, "start_time": "2026-09-23T03:54:00Z", "end_time": "2026-09-23T03:55:00Z",
         "uuid": "b5e7092b-3d6f-3a82-9e0a-4c6e8a0c2ea8", "source": FITBIT},
    ],
    "oxygen_saturation": [
        {"percentage": 95.0, "time": "2026-09-23T03:12:00Z", "uuid": "e1a3c5e7-0b2d-3f4a-8c6e-1a3c5e7a9cba", "source": FITBIT},
    ],
    "respiratory_rate": [
        {"rate": 14.6, "time": "2026-09-22T22:01:00Z", "uuid": "a7c9e1a3-5b7d-3f2c-9e4a-6c8e0a2c4edc", "source": FITBIT},
    ],
    "resting_heart_rate": [
        {"bpm": 56, "time": "2026-09-22T00:00:00Z", "uuid": "3b5d7f9a-1c3e-3a5f-8b7d-9f1b3d5f7afe", "source": FITBIT},
    ],
    "exercise": [
        {"type": "79", "start_time": "2026-09-22T16:05:00Z", "end_time": "2026-09-22T16:41:00Z", "duration_seconds": 2160,
         "uuid": "4c6e8a0c-2e4a-3c6e-9a0c-2e4a6c8e0b10", "source": FITBIT},
    ],
    "heart_rate_variability": [
        {"heart_rate_variability_millis": 24.9, "time": "2026-09-23T04:20:00Z",  # value and 5-min cadence REAL, LDC #53
         "uuid": "f59363e5-f8f4-4346-9992-7eb26af488a8", "source": FITBIT},  # REAL uuid, LDC #53
        {"heart_rate_variability_millis": 27.3, "time": "2026-09-23T04:25:00Z",
         "uuid": "0b2d4f6a-8c0e-4a2c-9e4a-6c8e0a2c4e32", "source": FITBIT},
    ],
    "vo2_max": [
        {"vo2_ml_per_min_per_kg": 44.0, "time": "2026-09-22T16:41:00Z", "uuid": "6e8a0c2e-4a6c-3e8a-8c2e-4a6c8e0a2c54", "source": FITBIT},
    ],
    "skin_temperature": [
        {"delta_celsius": -0.3, "baseline_celsius": 33.5, "time": "2026-09-22T22:01:00Z",
         "uuid": "8a0c2e4a-6c8e-3a0c-9e4a-6c8e0a2c4e76#1758578460000", "source": FITBIT},
    ],
    "_diagnostics": {
        "heart_rate_variability": diag(472, 2, "2026-09-16T22:10:00Z", "2026-09-23T04:25:00Z", "2026-09-23T05:43:39.120Z",
                                       "2026-09-23T04:20:00Z", "2026-09-23T04:25:00Z", "2026-09-23T05:33:06.439Z", "2026-09-16T05:33:02.112Z"),
        "respiratory_rate": diag(7, 1, "2026-09-16T22:40:00Z", "2026-09-22T22:01:00Z", "2026-09-23T05:43:39.502Z",
                                 "2026-09-22T22:01:00Z", "2026-09-22T22:01:00Z", "2026-09-23T05:33:06.947Z", "2026-09-16T05:33:02.112Z"),
        "total_calories": diag(10879, 2, "2026-09-16T05:33:00Z", "2026-09-23T05:47:00Z", "2026-09-23T05:47:41.004Z",
                               "2026-09-23T03:53:00Z", "2026-09-23T03:55:00Z", "2026-09-23T05:33:05.871Z", "2026-09-16T05:33:02.112Z", pages=3),
    },
}

deletions_only = {
    "timestamp": "2026-09-23T06:03:40.118Z",
    "app_version": "1.21.2",
    "source": "health_connect",
    "sequence": 1067,
    "deleted_records": [
        {"type": "total_calories", "uuid": "71a3c5e7-9b2d-3f40-8c6e-0a2c4e6a8c86"},
        {"type": "heart_rate", "uuid": HR_RECORD},  # drops every sample whose uuid starts with HR_RECORD + "#"
    ],
    "deletions_unavailable": ["nutrition"],
    "records_outside_window": {
        "heart_rate": {"count": 412, "from": "2026-09-14T06:02:11Z", "until": "2026-09-16T05:33:02.112Z"}
    },
}

backfill = {
    "timestamp": "2026-09-23T09:15:02.774Z",
    "app_version": "1.21.2",
    "source": "health_connect",
    "sequence": 1071,
    "backfill": True,
    "window_start": "2026-06-25T09:14:58.120Z",
    "window_end": "2026-06-28T09:14:58.120Z",
    "window_complete": True,
    "daily_totals": [
        {"date": "2026-06-25", "steps": 10221, "distance_meters": 7650.0, "total_calories": 2804.6},
    ],
    "resting_heart_rate": [
        {"bpm": 57, "time": "2026-06-26T00:00:00Z", "uuid": "1f3b5d7f-9a1c-3e5b-8d7f-9a1c3e5b7d98", "source": FITBIT},
    ],
}

bucketed = {
    "timestamp": "2026-09-23T05:48:12.431Z",
    "app_version": "1.21.2",
    "source": "health_connect",
    "sequence": 1066,
    "heart_rate": [
        {"bucket_start": "2026-09-23T05:30:00Z", "bucket_end": "2026-09-23T05:31:00Z",
         "sample_count": 12, "avg": 63.4, "min": 58.0, "max": 69.0, "sources": [FITBIT]},
    ],
    "_resolutions": {"heart_rate": "1m"},
}

test_ping = {"test": True, "message": "Test ping from Life Dashboard Companion",
             "timestamp": "2026-09-23T05:40:00.001Z", "source": "health_connect"}

hcw = {
    "timestamp": "2026-09-23T05:48:12.431Z",
    "app_version": "1.9.22",
    "steps": [
        {"count": 214, "start_time": "2026-09-22T22:00:00Z", "end_time": "2026-09-23T05:48:12.431Z"}
    ],
    "sleep": [
        {"session_end_time": "2026-09-23T04:42:00Z", "duration_seconds": 24060,
         "stages": [{"stage": "light", "start_time": "2026-09-22T22:09:30Z", "end_time": "2026-09-22T23:02:00Z", "duration_seconds": 3150}],
         "metadata": {"data_origin": FITBIT, "recording_method": "automatically_recorded"}}
    ],
    "heart_rate": [
        {"time": "2026-09-23T05:30:00Z", "avg": 63, "min": 58, "max": 69, "bpm": 63}
    ],
    "heart_rate_variability": [
        {"time": "2026-09-23T04:20:00Z", "avg": 24.9, "min": 24.9, "max": 24.9, "rmssd_millis": 24.9}
    ],
}

files = {
    "ldc-payload-sync.composed.json": sync,
    "ldc-payload-deletions.composed.json": deletions_only,
    "ldc-payload-backfill.composed.json": backfill,
    "ldc-payload-bucketed.composed.json": bucketed,
    "ldc-payload-test-ping.composed.json": test_ping,
    "hcw-payload.composed.json": hcw,
}
for name, payload in files.items():
    (OUT / name).write_text(json.dumps(payload, indent=2) + "\n")

# The app posts compact JSON (JsonObject.toString()) and signs those exact bytes.
compact = json.dumps(sync, separators=(",", ":")).encode()
(OUT / "ldc-payload-sync.composed.min.json").write_bytes(compact)
sig = "sha256=" + hmac.new(TEST_SECRET.encode("utf-8"), compact, hashlib.sha256).hexdigest()
(OUT / "ldc-payload-sync.composed.min.json.sig").write_text(
    f"secret (UTF-8 bytes of this hex string, not decoded): {TEST_SECRET}\nX-Signature: {sig}\n"
)
print(sig, len(compact))
