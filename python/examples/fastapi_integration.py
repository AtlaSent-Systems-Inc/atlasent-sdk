"""FastAPI integration example.

Run with::

    pip install fastapi uvicorn atlasent
    ATLASENT_API_KEY=ask_live_... uvicorn fastapi_integration:app
"""

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from atlasent import AsyncAtlaSentClient, AtlaSentDeniedError, AtlaSentError

app = FastAPI(title="AtlaSent + FastAPI Example")

# Shared client — connection pooling across requests
_client = AsyncAtlaSentClient(api_key="ask_live_your_key_here")


async def get_client() -> AsyncAtlaSentClient:
    return _client


class ModifyRecordRequest(BaseModel):
    patient_id: str
    change_reason: str


class ModifyRecordResponse(BaseModel):
    status: str
    permit_id: str
    permit_hash: str
    audit_hash: str


@app.post("/modify-record", response_model=ModifyRecordResponse)
async def modify_record(
    body: ModifyRecordRequest,
    client: AsyncAtlaSentClient = Depends(get_client),
):
    """Modify a patient record — gated by AtlaSent authorization."""
    try:
        permit = await client.protect(
            agent="fastapi-clinical-agent",
            action="modify_patient_record",
            context={
                "patient_id": body.patient_id,
                "change_reason": body.change_reason,
            },
        )
    except AtlaSentDeniedError as exc:
        raise HTTPException(status_code=403, detail=exc.reason) from exc
    except AtlaSentError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Authorization service error: {exc.message}",
        ) from exc

    return ModifyRecordResponse(
        status="modified",
        permit_id=permit.permit_id,
        permit_hash=permit.permit_hash,
        audit_hash=permit.audit_hash,
    )


@app.on_event("shutdown")
async def shutdown():
    await _client.close()
