"""Flask integration example.

Run with::

    pip install flask atlasent
    ATLASENT_API_KEY=ask_live_... flask --app flask_integration run
"""

from flask import Flask, abort, jsonify, request

from atlasent import AtlaSentClient, AtlaSentDeniedError, AtlaSentError

app = Flask(__name__)

# Shared client — connection pooling across requests
client = AtlaSentClient(api_key="ask_live_your_key_here")


@app.route("/modify-record", methods=["POST"])
def modify_record():
    """Modify a patient record — gated by AtlaSent authorization."""
    body = request.get_json() or {}

    try:
        permit = client.protect(
            agent="flask-clinical-agent",
            action="modify_patient_record",
            context={
                "patient_id": body.get("patient_id", ""),
                "change_reason": body.get("change_reason", ""),
            },
        )
    except AtlaSentDeniedError as exc:
        abort(403, description=exc.reason)
    except AtlaSentError as exc:
        abort(502, description=f"Authorization service error: {exc.message}")

    return jsonify(
        status="modified",
        permit_id=permit.permit_id,
        permit_hash=permit.permit_hash,
        audit_hash=permit.audit_hash,
    )
