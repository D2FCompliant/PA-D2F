import type { CbmUseCase } from "./cbm-preflight";
import { REGULATORY_FLOWS } from "./regulatory-coverage";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return String(value ?? "").trim(); }

export type DispatchPlan = {
  useCase: CbmUseCase;
  invoiceFlow: string | null;
  reportingFlows: string[];
  lifecycleFlows: string[];
  syntax: string | null;
  transport: { network: "PEPPOL" | "BILATERAL"; protocol: "AS4" | "AGREED"; senderAccessPoint: string; receiverAccessPoint: string | null; participantIdentifier: string | null; documentProfile: string | null };
  route: { sender: "SOURCE_SI"; senderPa: "D2F_PA_SANDBOX"; receiverPa: string | null; recipient: string | null };
  dispatchable: boolean;
  sandboxExecutable: boolean;
  productionReady: boolean;
  blockers: Array<{ code: string; owner: string; message: string }>;
  sandboxSimulation: { receiverPa: boolean; ppf: boolean; directory: boolean; externalNetworkCalled: false };
};

export function buildDispatchPlan(body: JsonRecord, useCase: CbmUseCase): DispatchPlan {
  const document = object(body.document);
  const routing = object(body.routing);
  const custom = object(routing.customProfile || body.customProfile);
  const rawSyntax = text(document.syntax || document.format || body.syntax || body.format).toUpperCase().replace(/_/g, "-");
  const syntax = rawSyntax === "FACTURX" ? "FACTUR-X" : rawSyntax || null;
  const coreSyntax = ["UBL", "CII", "FACTUR-X"].includes(syntax || "");
  let invoiceFlow: string | null = null;
  let reportingFlows: string[] = [];
  let lifecycleFlows: string[] = [];
  const blockers: DispatchPlan["blockers"] = [];

  if (useCase === "FR_DOMESTIC_B2B") {
    invoiceFlow = coreSyntax ? "2" : "3";
    reportingFlows = ["1"];
    lifecycleFlows = coreSyntax ? ["6"] : ["6", "7"];
    if (!coreSyntax && !(custom.bilateralAgreement === true && text(custom.profileId) && text(custom.profileVersion))) {
      blockers.push({ code: "FLUX3_BILATERAL_PROFILE_REQUIRED", owner: "PA_INTEROPERABILITY", message: "Flux 3 requires a bilateral agreement plus an identified and versioned structured profile." });
    }
  } else if (useCase === "FR_CROSS_BORDER") {
    invoiceFlow = "8";
    reportingFlows = ["10.1", "10.2"];
    lifecycleFlows = ["6"];
  } else if (useCase === "FR_B2C") {
    invoiceFlow = "9";
    reportingFlows = ["10.3", "10.4"];
    lifecycleFlows = ["6"];
  } else if (useCase === "FR_DOMESTIC_B2G") {
    invoiceFlow = "4";
    lifecycleFlows = ["6"];
    blockers.push({ code: "CHORUS_PRO_CONTRACT_REQUIRED", owner: "PA_INTEROPERABILITY", message: "The applicable Chorus Pro contract and sandbox qualification are required." });
  } else {
    blockers.push({ code: "USE_CASE_UNDETERMINED", owner: "SOURCE_APPLICATION", message: "Seller and buyer countries and legal nature are required before a regulatory route can be selected." });
  }

  if (!syntax) blockers.push({ code: "STRUCTURED_SYNTAX_REQUIRED", owner: "SOURCE_APPLICATION", message: "The generated structured syntax must be declared (UBL, CII, Factur-X or an agreed custom profile)." });
  const required = [invoiceFlow, ...reportingFlows, ...lifecycleFlows].filter(Boolean) as string[];
  for (const flow of required) {
    const coverage = REGULATORY_FLOWS.find((item) => item.flow === flow);
    if (!coverage || coverage.status !== "IMPLEMENTED") {
      blockers.push({ code: `FLOW_${flow.replace(".", "_")}_NOT_OPERATIONAL`, owner: "D2F_PA", message: `Flux ${flow} is ${coverage?.status || "UNDECLARED"}; dispatch is blocked until its official contract and evidence pass.` });
    }
  }
  const receiverPa = text(routing.receiverPa || routing.receptionPlatform) || null;
  const electronicAddress = object(routing.electronicAddress);
  const recipient = text(electronicAddress.value || routing.recipientAddress) || null;
  const requestedNetwork = text(routing.network || "PEPPOL").toUpperCase();
  const network = requestedNetwork === "BILATERAL" ? "BILATERAL" : "PEPPOL";
  const participantIdentifier = text(routing.peppolParticipantIdentifier || routing.participantIdentifier) || recipient;
  const documentProfile = text(routing.peppolDocumentProfile || routing.documentProfile) || (coreSyntax ? "FRANCE-EN16931" : null);
  const receiverAccessPoint = text(routing.receiverAccessPoint || routing.receiverPa) || null;
  if (useCase === "FR_DOMESTIC_B2B" && (!receiverPa || !recipient)) blockers.push({ code: "RECEIVER_PA_ROUTE_REQUIRED", owner: "D2F_PA", message: "The receiving PA and BT-49 must be resolved from the directory before PA-to-PA dispatch." });

  const sourceBlockers = blockers.filter((item) => item.owner === "SOURCE_APPLICATION" || item.code === "FLUX3_BILATERAL_PROFILE_REQUIRED");
  return {
    useCase, invoiceFlow, reportingFlows, lifecycleFlows, syntax,
    transport: { network, protocol: network === "PEPPOL" ? "AS4" : "AGREED", senderAccessPoint: "D2F_PA_SANDBOX_AP", receiverAccessPoint, participantIdentifier, documentProfile },
    route: { sender: "SOURCE_SI", senderPa: "D2F_PA_SANDBOX", receiverPa, recipient },
    dispatchable: blockers.length === 0,
    sandboxExecutable: sourceBlockers.length === 0,
    productionReady: blockers.length === 0,
    blockers,
    sandboxSimulation: { receiverPa: true, ppf: true, directory: true, externalNetworkCalled: false },
  };
}
