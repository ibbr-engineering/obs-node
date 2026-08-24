import * as assert from "assert";
import { it as test } from "mocha";

import { resetWarnings, sanitizeLabels } from "../src/guard";

test("labels with forbidden names are dropped", () => {
  resetWarnings();
  const out = sanitizeLabels({
    service: "booking",
    patient_id: "507f1f77bcf86cd799439011",
    mrn: "RM-00123",
    route: "/api/patients/:id",
  });
  assert.deepStrictEqual(out, {
    service: "booking",
    route: "/api/patients/:id",
  });
});

test("PHI-shaped values are dropped even under safe label names", () => {
  resetWarnings();
  const out = sanitizeLabels({
    service: "booking",
    contact: "budi@example.com",
    reference: "+628123456789",
    identity: "3171234567890123",
    route: "/api/x",
  });
  assert.deepStrictEqual(out, { service: "booking", route: "/api/x" });
});

test("forbidden label names are case insensitive", () => {
  resetWarnings();
  assert.deepStrictEqual(sanitizeLabels({ Patient_ID: "x", service: "s" }), {
    service: "s",
  });
});

test("undefined and null are dropped while numbers become strings", () => {
  resetWarnings();
  assert.deepStrictEqual(
    sanitizeLabels({ service: "x", status: 200, missing: undefined }),
    { service: "x", status: "200" }
  );
});

test("ordinary metric values are retained", () => {
  resetWarnings();
  const labels = {
    service: "fdc-booking-api",
    route: "/api/clinics/:slug/slots",
    method: "GET",
    status_class: "2xx",
    version: "2.6.54",
  };
  assert.deepStrictEqual(sanitizeLabels(labels), labels);
});
