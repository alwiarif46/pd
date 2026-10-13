# CUI and Export-Control Marking Rules

**Purpose:** Identify Controlled Unclassified Information (CUI) and export-control markings in uploaded documents. When found, AI processing stops until the user confirms the file may be sent to a third party.

**Status:** Draft v1 · Phase 0

## Markings to Detect

### CUI Markings

Federal CUI markings as defined in Executive Order 13556 and the CUI Regulation (32 CFR Part 2002):

1. **Standard CUI marking pattern:**
   - `CUI` at the top or bottom of pages
   - `CUI//SP-XXX` where XXX is a category (e.g., SP-HLTH for Health, SP-PRIV for Privacy)
   - `CUI//SPECIAL` for special categories
   - `CUI//DESIGNATION` for designation indicators

2. **Controlled Technical Information (CTI):**
   - `CTI`
   - `CTI//XXX`

3. **DoD CUI:**
   - `CUI` with DoD-specific categories
   - `DD Form 254` references (though this is a form number, not a marking)

4. **Other government CUI variants:**
   - `CUI - <category>`
   - `<Agency> CUI`
   - `CUI Control Category: <category>`

### Export-Control Markings

1. **Export Administration Regulations (EAR) markings:**
   - `EAR99`
   - `ECCN XXXXXXX` (where X is alphanumeric)
   - `NLR`
   - `Export Controlled`
   - `Technical Data`
   - `U.S. EAR`

2. **International Traffic in Arms Regulations (ITAR) markings:**
   - `ITAR`
   - `DDTC`
   - `Technical Data - ITAR`
   - `Defense Article`
   - `USML Category <category>`

3. **NUCLEAR Non-Proliferation Treaty markings:**
   - `NNP`
   - `Nuclear Non-Proliferation`
   - `10 CFR Part 810` references

4. **Other export control indicators:**
   - `Export Restricted`
   - `Proprietary - Export Controlled`
   - `Confidential - Export Controlled`

### Classification Markings (Out of Scope but Logged)

These markings indicate classified information, which the app does not accept. If found, the file is rejected outright:

- `TOP SECRET`
- `SECRET`
- `CONFIDENTIAL`
- `UNCLASSIFIED//FOUO` (For Official Use Only)
- `NOFORN` (No Foreign Nationals)
- `EYES ONLY`
- `LIMDIS` (Limited Distribution)
- `Proprietary` (when used in a classification context)

## Detection Logic

### Pattern Matching

The marking check runs on extracted page text after OCR, using regex patterns:

```typescript
const cuiPatterns = [
  /\bCUI\b/,
  /\bCUI\/\/SP-[\w-]+\b/,
  /\bCUI\/\/SPECIAL\b/,
  /\bCUI\/\/DESIGNATION\b/,
  /\bCTI\b/,
  /\bCTI\/\/[\w-]+\b/,
];

const exportControlPatterns = [
  /\bEAR99\b/,
  /\bECCN\s*[\w-]+\b/i,
  /\bITAR\b/i,
  /\bDDTC\b/i,
  /\bExport\s+Controlled\b/i,
  /\bTechnical\s+Data\b/i,
  /\bUSML\s+Category\b/i,
];

const classificationPatterns = [
  /\bTOP\s+SECRET\b/i,
  /\bSECRET\b/i,
  /\bCONFIDENTIAL\b/i,
  /\bUNCLASSIFIED\/\/FOUO\b/i,
  /\bNOFORN\b/i,
  /\bEYES\s+ONLY\b/i,
  /\bLIMDIS\b/i,
];
```

### False Positive Handling

Some patterns may appear in innocuous contexts (e.g., "confidential" in a privacy policy). Rules:

1. **Context check:** If a marking appears, check if it's in a header, footer, or page border area (higher confidence).
2. **Multiple occurrences:** A single occurrence may be a false positive; multiple occurrences increase confidence.
3. **Document metadata:** Check if the document title or author field suggests government origin.

### Confirmation Flow

When markings are found:

1. **Block AI processing:** Jobs for the document pause with status `marking_blocked`.
2. **Show user the findings:** Display which markings were found and on which pages.
3. **Request confirmation:** User must click "I confirm this file may be processed by a third-party AI service."
4. **Log the decision:** Write to `audit_log` with action `marking_confirmed`, the document ID, and the markings found.
5. **Resume processing:** Update `documents.marking_status` to `confirmed` and queue the next job.

If the user declines:
- Delete the document and its files.
- Log the decision to `audit_log`.
- Show a message that CUI and export-controlled files are not supported.

## Implementation Notes

- Run this check in the worker after text extraction but before any AI calls.
- Store the list of found markings in `documents.marking_found` as a JSON array.
- The initial status is `none`. When markings are found, set to `blocked`. After confirmation, set to `confirmed`.
- Resumes (kind `resume`) skip this check - they are not solicitation documents.

## Test Documents

Create test PDFs for each marking type to validate detection:

1. `test-cui-standard.pdf` - Contains `CUI` marking
2. `test-cui-sp-hlth.pdf` - Contains `CUI//SP-HLTH`
3. `test-ear99.pdf` - Contains `EAR99`
4. `test-itar.pdf` - Contains `ITAR`
5. `test-classified.pdf` - Contains `SECRET` (should be rejected)
6. `test-no-markings.pdf` - No markings (should pass)

## Reference Documents

- [DoD CUI Program](https://www.dodcui.mil/)
- [CUI Executive Order 13556](https://www.federalregister.gov/documents/2010/11/04/2010-28559/classified-national-security-information-and-controlled-unclassified-information)
- [32 CFR Part 2002 - CUI Regulation](https://www.ecfr.gov/current/title-32/part-2002)
- [Export Administration Regulations (EAR)](https://www.bis.doc.gov/index.php/policy-guidance/export-administration-regulations)
- [International Traffic in Arms Regulations (ITAR)](https://www.pmddtc.state.gov/?id=ddtc_kb_article_page&sys_id=24d560e1db457f90f693f59f8f8e6e7c)
