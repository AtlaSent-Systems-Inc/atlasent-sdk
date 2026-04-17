"""FastAPI integration example.

Run with::

    pip install fastapi uvicorn atlasent
    ATLASENT_API_KEY=ask_live_... uvicorn fastapi_integration:app
"""

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from atlasent import AsyncAtlaSentClient, AtlaSentError

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
    permit_hash: str
    audit_hash: str


@app.post("/modify-record", response_model=ModifyRecordResponse)
async def modify_record(
    body: ModifyRecordRequest,
    client: AsyncAtlaSentClient = Depends(get_client),
):
    """Modify a patient record — gated by AtlaSent authorization."""
    try:
        result = await client.authorize(
            agent="fastapi-clinical-agent",
            action="modify_patient_record",
            context={
                "patient_id": body.patient_id,
                "change_reason": body.change_reason,
            },
        )
    except AtlaSentError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Authorization service error: {exc.message}",
        ) from exc

    if not result.permitted:
        raise HTTPException(status_code=403, detail=result.reason)

    return ModifyRecordResponse(
        status="modified",
        permit_hash=result.permit_hash,
        audit_hash=result.audit_hash,
    )


@app.on_event("shutdown")
async def shutdown():
    await _client.close()
