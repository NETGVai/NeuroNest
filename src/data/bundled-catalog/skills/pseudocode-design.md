---
id: pseudocode-design
name: Pseudocode Design
description: Design algorithms and logic flows using pseudocode before writing production code
source: bundled
version: 1.0.0
category: code-quality
tags: [pseudocode, algorithms, design, logic, planning]
scope: project
---

# Pseudocode Design

## Why Pseudocode First

- Separates logic design from syntax concerns
- Makes algorithms reviewable by non-specialists
- Catches logical errors before implementation investment
- Serves as documentation for complex algorithms

## Pseudocode Guidelines

1. Use plain language with consistent indentation
2. Define inputs, outputs, and preconditions clearly
3. Use standard control flow: IF/ELSE, FOR, WHILE, RETURN
4. Name variables descriptively
5. Include error handling paths

## Example Structure

```
FUNCTION processOrders(orders):
  INPUT: list of Order objects
  OUTPUT: ProcessingResult with success/failure counts

  SET successCount = 0
  SET failures = empty list

  FOR EACH order IN orders:
    IF order.isValid():
      TRY:
        order.process()
        successCount += 1
      CATCH error:
        failures.add({order, error})
    ELSE:
      failures.add({order, "Invalid order"})

  RETURN ProcessingResult(successCount, failures)
```

## From Pseudocode to Code

- Translate one block at a time
- Write tests for each translated section
- Keep the pseudocode as a comment or design doc
- Update pseudocode if implementation reveals design flaws
