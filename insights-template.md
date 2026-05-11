# llm session insights template

Goal: design our own compact, useful review of LLM-agent sessions: how the user works, what produced leverage, what caused friction, and what should change next.

Sharp headlines, behavioral interpretation, concrete evidence, and actionable next steps. Drop anything that feels like dashboard filler, product marketing, or overly confident psychoanalysis.

Assume the data is already available: messages, timestamps, tools, diffs, files, commands, errors, commits, outcomes, and repos.

## shape

1. title/date range
2. at a glance
3. key metrics
4. what you work on
5. how you use agents
6. impressive things
7. where things go wrong
8. things to try
9. standing instructions to add
10. next-level workflows
11. notable incidents

Use this structure for every major section:

- purpose: why the section exists
- prompt: the analysis question to answer
- want: what the final output should contain

Design principles:

- insight over inventory
- evidence over vibes
- recommendations over raw analytics
- agent-neutral wording unless the data is agent-specific
- fewer sections, stronger claims
- only show metrics that change what the reader believes

## at a glance

### purpose

Give the reader the whole report in one screen: what is working, what is not, and what to try next.

### prompt

> Based on all sessions in the period, identify the strongest success pattern, the most repeated friction pattern, and the highest-leverage next action. Use concrete evidence, but keep it compressed.

### want

Three short blocks:

- what's working: 1 paragraph with 2-4 concrete examples or metrics
- what's hindering you: 1 paragraph naming 2-3 recurring failure modes
- quick wins: 1 paragraph with 2-3 practical changes

Avoid generic “you are productive” praise. The section should feel specific enough that only this user could have received it.

## key metrics

### purpose

Anchor the report in scale and behavior without turning it into a dashboard.

### prompt

> Which metrics explain the story of this period? Choose only numbers that support the report's claims about work type, collaboration style, success, or friction.

### want

A compact metrics strip or small table. Good defaults:

- messages, sessions, date range, active days
- files touched, lines added/removed
- top repos/projects
- top tools and languages
- outcomes
- tool errors / rejected actions
- session overlap / parallel work
- user response-time distribution

Omit metrics that do not explain behavior.

## what you work on

### purpose

Show the main bodies of work, not every task. This answers: “where did the agent time go?”

### prompt

> Cluster sessions by repo, goal, and changed files. Produce 4-7 themes. For each theme, summarize what changed, rough session count, and notable outcomes or measurements.

### want

For each theme:

- short name
- approximate session count
- 2-4 sentence summary
- measured outcomes if available

Prefer themes like “llmlake ingestion pipeline” or “arbe LOC reduction” over raw goal labels like “refactor”.

## how you use agents

### purpose

Describe the user's collaboration style and operating mode.

### prompt

> Infer how the user works with agents from message length, response time, interruptions, tool usage, session overlap, tests, commits, and outcomes. What patterns define the user's style?

### want

2-4 paragraphs with concrete examples, ending with one sentence that captures the key pattern.

Useful angles:

- terse vs detailed prompting
- how quickly the user interrupts drift
- tolerance for autonomy
- surgical edits vs greenfield work
- tests/commits/tickets as anchors
- parallel sessions

## impressive things

### purpose

Surface the strongest accomplishments and high-performing workflows.

### prompt

> What were the most impressive outcomes in this period? Prefer measured results and repeated workflows over one-off anecdotes.

### want

2-4 items. Each item should include:

- headline
- why it matters
- evidence: metrics, examples, outcomes

Good candidates:

- performance wins
- large LOC reductions
- hard debugging
- multi-file feature delivery
- clean ticket-to-commit loops

## where things go wrong

### purpose

Name repeated friction so it can be prevented next time.

### prompt

> What failure modes caused corrections, reversions, stalls, rejected actions, or visible user frustration? For each, explain the pattern, show representative incidents, and give the smallest preventive change.

### want

2-4 failure modes. For each:

- pattern name
- short explanation
- 1-3 representative incidents
- concrete adjustment

Rules:

- critique patterns, not personality
- distinguish unclear user shorthand from agent overreach
- every critique should produce a usable fix

## things to try

### purpose

Convert observations into practical workflow changes the user can adopt immediately.

### prompt

> Which existing agent features, prompt habits, hooks, skills, or checklists fit this user's repeated work and friction patterns?

### want

3-5 recommendations. Each should include:

- name
- why it fits this user
- copy-paste starter prompt or config snippet

Good candidates:

- custom skills / slash commands
- hooks
- parallel task agents
- prompt templates
- standing instructions
- commit checklist
- test-first loops

## standing instructions to add

### purpose

Turn repeated corrections into durable instructions for future sessions.

### prompt

> Which user preferences were corrected often enough, or expensively enough, that they should become standing instructions?

### want

Grouped copy-paste blocks. Possible groups:

- code style
- refactoring
- git/version control
- investigation before action
- testing
- docs style

Only include instructions supported by multiple incidents or one high-cost incident. Keep bullets short and imperative.

## next-level workflows

### purpose

Show what becomes possible if the user's successful patterns are automated, parallelized, or made more autonomous.

### prompt

> Based on observed high-performing workflows, what ambitious agent workflows would compound this user's strengths? Keep speculation grounded in actual behavior.

### want

2-3 ideas. Each should include:

- workflow name
- why it follows from observed behavior
- getting-started prompt

Examples:

- autonomous LOC-reduction swarm
- profile/benchmark/fix loop
- test-anchored feature implementation
- multi-agent codebase survey

## notable incidents

### purpose

Provide memorable evidence for the report's claims.

### prompt

> Which short quotes or incidents best illustrate the major success and friction patterns? Prefer moments that changed the session direction.

### want

3-8 short quotes/incidents. Each should include:

- quote or concise incident summary
- what it illustrates

Use as evidence, not gossip.

## classification

Classify lightly, enough to support the sections above.

### work type

- refactor / LOC reduction
- feature
- bugfix
- docs
- investigation
- performance
- git/version control
- task management
- setup/infrastructure

### session type

- quick question
- single task
- multi-task
- iterative refinement
- debugging
- autonomous/long-running loop

### outcome

- fully achieved
- mostly achieved
- not achieved
- abandoned/unclear

### friction type

- wrong approach
- scope creep / excessive change
- too timid / insufficient effort
- misunderstood referent
- premature implementation
- ignored existing convention
- buggy code
- tool failure
- version-control mistake
- user rejected action

### positive signal

- surgical edit worked
- multi-file change landed
- tests/checks passed
- strong debugging
- useful explanation
- performance improved
- meaningful LOC reduction
- good context retrieval
- commit/release completed

## detection hints

### corrections

Flag short user messages soon after agent action, especially with:

- no / not / stop / don't / just / instead / I said / why did / that's wrong

Classify by comparing the correction to the preceding action.

### scope mismatch

Signals:

- large diff after “small”, “minimal”, “just”, “only”
- new files after a surgical request
- user asks to revert, cut, or simplify
- docs/style changed during a code-only task

### too timid

Signals:

- tiny diff after broad refactor request
- user asks “is that all?”
- no checks before claiming completion

### convention miss

Signals:

- new names, fields, commands, aliases, or abstractions
- user points to existing docs or vocabulary
- later diff removes the invented term

### strong success

Signals:

- tests/checks pass
- commit created
- user approves or immediately gives next task
- measured improvement
- no correction after substantial agent action

## tone

- direct, useful, specific
- praise concrete outcomes
- avoid generic productivity language
- make critiques actionable
- prefer measured examples
- keep it skimmable
