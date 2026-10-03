# AgentGenerator patterns

<xml_optimization_patterns>
  <optimal_component_sequence>
    Research shows this order improves performance by 12-17%:
    1. Context (hierarchical: system→domain→task→execution)
    2. Role (clear identity and expertise)
    3. Task (specific objective)
    4. Instructions/Workflow (detailed procedures)
    5. Examples (when needed)
    6. Constraints (boundaries)
    7. Validation (quality checks)
  </optimal_component_sequence>
  
  <component_ratios>
    <role>5-10% of total prompt</role>
    <context>15-25% hierarchical information</context>
    <instructions>40-50% detailed procedures</instructions>
    <examples>20-30% when needed</examples>
    <constraints>5-10% boundaries</constraints>
  </component_ratios>
  
  <routing_patterns>
    <subagent_references>Always use @ symbol (e.g., @research-assistant)</subagent_references>
    <delegation_syntax>Route to @{agent-name} when {condition}</delegation_syntax>
    <context_specification>Always specify context_level for each route</context_specification>
    <return_specification>Define expected_return for every subagent call</return_specification>
  </routing_patterns>
  
  <workflow_patterns>
    <stage_structure>id, name, action, prerequisites, process, checkpoint, outputs</stage_structure>
    <decision_trees>Use if/else logic with clear conditions</decision_trees>
    <validation_gates>Checkpoints with numeric thresholds (e.g., 8+ to proceed)</validation_gates>
    <failure_handling>Define what happens when validation fails</failure_handling>
  </workflow_patterns>
</xml_optimization_patterns>

<agent_type_templates>
  <orchestrator_template>
    Primary coordinator with:
    - Multi-stage workflow execution
    - Routing intelligence (analyze→allocate→execute)
    - Context engineering (3-level allocation)
    - Subagent coordination
    - Validation gates
    - Performance metrics
  </orchestrator_template>
  
  <research_subagent_template>
    Information gathering specialist with:
    - Level 1 context (isolation)
    - Clear research scope
    - Source validation
    - Citation requirements
    - Structured output
  </research_subagent_template>
  
  <validation_subagent_template>
    Quality assurance specialist with:
    - Level 2 context (standards + rules)
    - Validation criteria
    - Scoring system
    - Prioritized feedback
    - Pass/fail determination
  </validation_subagent_template>
  
  <processing_subagent_template>
    Data transformation specialist with:
    - Level 1 context (task only)
    - Input validation
    - Transformation logic
    - Output formatting
    - Error handling
  </processing_subagent_template>
  
  <generation_subagent_template>
    Content/artifact creation specialist with:
    - Level 2 context (templates + standards)
    - Generation parameters
    - Quality criteria
    - Format specifications
    - Validation checks
  </generation_subagent_template>
</agent_type_templates>
