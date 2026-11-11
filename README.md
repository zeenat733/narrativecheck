# NarrativeCheck

An AI-powered decision support tool that reviews police charge narratives before a record is finalized. Built for the **Challenge+X competition** (Unissant challenge) at George Mason University, where it placed **2nd place**.

## What It Does

When an officer writes a charge narrative, small errors or gaps can lead to dismissed cases or unjust outcomes. NarrativeCheck catches those issues before the record is locked in.

Given a charge narrative and the structured case facts, it:

- Flags missing or contradictory information between the narrative and the facts
- Checks whether the selected charge fits what the narrative actually describes
- Points every flag to the exact sentence in the narrative so the officer knows precisely what to fix
- Routes ambiguous or unclear cases to a human reviewer rather than issuing an automated judgment

The officer always makes the final call. NarrativeCheck is decision support, not a decision maker.

## Why It Matters

With AI, the hard part is not getting an answer. It is making sure you can trust it. NarrativeCheck is built around that principle: every flag is explainable, every link goes back to source text, and a human is always in the loop for anything uncertain.

## Tech Stack

- **React 18** with React Router for the frontend
- **Vite** for bundling
- **Tailwind CSS** with shadcn/ui components
- **Base44** for
