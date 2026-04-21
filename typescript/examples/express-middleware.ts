/**
 * Express integration via `expressGuard()`.
 *
 * The middleware calls `client.gate()` before the handler runs. On
 * permit, the verified `GateResult` is attached as `req.atlasent`.
 * On deny or transport failure, `next(err)` fires so Express'
 * error-handling middleware can map it to an HTTP response.
 *
 * This example does not import express — the package isn't a
 * dependency of the SDK. Copy the pattern into your own app.
 */

import {
  AtlaSentClient,
  PermissionDeniedError,
  expressGuard,
  type ExpressLikeRequest,
} from "@atlasent/sdk";

interface PatientRequest extends ExpressLikeRequest {
  params: { patientId: string };
  user: { id: string };
}

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY ?? "" });

const guard = expressGuard<PatientRequest>(client, {
  action: "read_patient_record",
  agent: (req) => req.user.id,
  context: (req) => ({ patientId: req.params.patientId }),
});

// Sketch of how you'd wire it into Express:
//
//   const app = express();
//   app.get("/patients/:patientId", guard, (req, res) => {
//     res.json({
//       patient: /* ... */,
//       permitHash: req.atlasent!.verification.permitHash,
//     });
//   });
//
//   app.use((err, _req, res, _next) => {
//     if (err instanceof PermissionDeniedError) {
//       return res.status(403).json({ error: err.reason });
//     }
//     res.status(500).json({ error: err.message });
//   });
//
// The two references below keep tsconfig.examples happy by making
// the helpers observably used.
void guard;
void PermissionDeniedError;
