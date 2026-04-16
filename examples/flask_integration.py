"""Flask integration example.

Run with:
    pip install flask atlasent
    ATLASENT_API_KEY=ask_live_... flask --app flask_integration run
"""

from flask import Flask, abort, jsonify, request

from atlasent import AtlaSentClient, AtlaSentDenied, AtlaSentError

app = Flask(__name__)

# Shared client — connection pooling across requests
client = AtlaSentClient(api_key="ask_live_your_key_here")


@app.route("/modify-record", methods=["POST"])
def modify_record():
    """Modify a patient record — gated by AtlaSent authorization."""
    body = request.get_json()
    patient_id = body.get("patient_id", "")
    change_reason = body.get("change_reason", "")

    try:
        gate = client.gate(
            action_type="modify_patient_record",
            actor_id="flask-clinical-agent",
            context={
                "patient_id": patient_id,
                "change_reason": change_reason,
            },
        )
    except AtlaSentDenied as e:
        abort(403, description=e.reason)
    except AtlaSentError as e:
        abort(502, description=f"Authorization service error: {e.message}")

    return jsonify(
        status="modified",
        permit_hash=gate.verification.permit_hash,
        audit_hash=gate.evaluation.audit_hash,
    )


@app.teardown_appcontext
def teardown(exception=None):
    pass  # client.close() called at process exit
