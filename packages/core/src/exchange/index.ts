// Credential exchange (FIDO CXF 1.0). Format only: the OS performs the CXP transfer, so
// nothing here touches HPKE. See docs/credential-exchange.md.

export { parseCxf } from "./from-cxf";
export { exportToOs, importFromOs } from "./os-transfer";
export { pkcs8FromScalar } from "./passkey-key";
export { type CxfExportOptions, type CxfExportResult, toCxf } from "./to-cxf";
export {
	CXF_VERSION,
	type CxfCredential,
	type CxfEditableField,
	type CxfItem,
	type CxfPayload,
	cxfPayloadSchema,
} from "./types";
