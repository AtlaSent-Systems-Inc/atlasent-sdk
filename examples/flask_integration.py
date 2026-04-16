"""Flask integration example.

Run with::

    pip install flask atlasent
    ATLASENT_API_KEY=ask_live_... flask --app flask_integration run
"""

from flask import Flask, abort, jsonify, request

from atlasent import AtlaSentClient, AtlaSentError

app = Flask(__name__)

# Shared client — connection pooling across requests
client = AtlaSentClient(api_key="ask_live_your_key_here")


@app.route("/modify-record", methods=["POST"])
def modify_record():
    """Modify a patient record — gated by AtlaSent authorization."""
    body = request.get_json() or {}

    try:
        result = client.authorize(
            agent="flask-clinical-agent",
            action="modify_patient_record",
            context={
                "patient_id": body.get("patient_id", ""),
                "change_reason": body.get("change_reason", ""),
            },
        )
    except AtlaSentError as exc:
        abort(502, description=f"Authorization service error: {exc.message}")

    if not result.permitted:
        abort(403, description=result.reason)

    return jsonify(
        status="modified",
        permit_hash=result.permit_hash,
        audit_hash=result.audit_hash,
    )
