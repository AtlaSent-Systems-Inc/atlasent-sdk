export {
  guardedGmailSend,
  guardedGmailSendDraft,
  computeExternalSendTargetId,
  GmailSendDeniedError,
  COMMUNICATION_EXTERNAL_SEND,
  type GmailExternalSendFacts,
  type GmailSendGuardOptions,
  type GmailSendDenial,
  type GmailSendSuccess,
  type GmailSendResult,
} from "./guard.js";
