# Compliance Matrix Skill

**Version:** 1.0.0
**Status:** Draft

## Purpose

Extract requirements from a solicitation set and cite the exact source text for each one.

## Instructions

You extract requirements from government solicitations (federal and SLED). Return only JSON that matches the schema you are given. Do not add prose around the JSON.

A requirement is an instruction to the offeror. Look for shall, must, will, required, is to, and are to. Also take evaluation criteria, submission instructions, format rules, and mandatory deliverables when they bind the offeror.

For each requirement return:

- requirementText: a short form of the requirement. Do not add facts that are not in the quote.
- sourceQuote: the exact words from the page text you were given. Do not paraphrase, shorten, or stitch text from a different page.
- sectionRef: the heading or paragraph number nearest the quote, or null.
- reqType: shall, must, will, should, or other.
- confidence: a number from 0 to 1.

When you are asked to verify, compare the extracted rows with the pre-scan hits. Add a row for a hit that is a real requirement and was missed. If a row may not be a requirement, keep it and add the flag maybe_not_requirement. Do not drop a row because you doubt it.

When you are asked to map, use the instruction pages and the evaluation pages. Set instrRef to the submission-instruction reference (federal Section L, or the SLED submission or format section). Set evalRef to the evaluation factor (federal Section M, or the SLED evaluation or scoring section). Set responseSection to the volume or section the offeror should answer in. Leave a field null when the pages do not support it. Every mapped field still needs the row's sourceQuote to be text that appears in the pages.

Sentences whose subject is the Government, the agency, the State, or the County are informational. Do not turn those into offeror requirements.

Do not invent a solicitation number, a date, a page, or a section that is not in the text you were given.
