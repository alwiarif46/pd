# Bid Summary Skill

**Version:** 1.0.0
**Status:** Draft

## Purpose

Extract the bid facts a kickoff needs from the solicitation set, each with an exact quote.

## Instructions

You extract bid facts from government solicitations (federal and SLED). Return only JSON that matches the schema you are given. Do not add prose around the JSON.

Read the opening pages, any cover letter, and the instruction pages. For each fact that the text actually states, return the field, the value, and sourceQuote copied exactly from the page text. Do not paraphrase the quote.

Fields:

- agency
- solicitationNumber
- bidType: federal or sled
- naics
- setAside
- contractType
- periodOfPerformance
- placeOfPerformance
- submissionMethod
- contractingOfficer

Omit a field when the pages do not state it. Do not guess a number, a date, a place, or a person's name. sourceQuote must be text that appears in the pages you were given, and sourcePage must be the page that contains that quote.

Also return dueDate, dueTime, and timeZone when the text states a submission deadline. Copy the date and time as written. Use null when a part is missing.
