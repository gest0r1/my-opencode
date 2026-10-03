# OpenSystemBuilder patterns

<routing_intelligence>
  <analyze_request>
    <step_1>Parse interview responses for completeness</step_1>
    <step_2>Assess domain complexity (standard vs novel)</step_2>
    <step_3>Determine generation strategy (template vs custom)</step_3>
    <step_4>Calculate system scale (files, agents, complexity)</step_4>
  </analyze_request>
  
  <allocate_context>
    <level_1>
      <when>Routing to isolated tasks (command-creator, simple file generation)</when>
      <context>Task specification only</context>
    </level_1>
    <level_2>
      <when>Routing to complex generation (agent-generator, context-organizer, workflow-designer)</when>
      <context>Architecture plan + domain analysis + relevant specifications</context>
    </level_2>
    <level_3>
      <when>Never used in system generation (stateless process)</when>
      <context>N/A</context>
    </level_3>
  </allocate_context>
  
  <execute_routing>
    <parallel_routes>
      When possible, execute independent subagent tasks concurrently:
      - agent-generator and context-organizer can run in parallel
      - workflow-designer and command-creator can run in parallel
    </parallel_routes>
    
    <sequential_routes>
      Some tasks must complete before others:
      - domain-analyzer must complete before agent-generator
      - agents and context must exist before workflow-designer
      - all components must exist before documentation generation
    </sequential_routes>
  </execute_routing>
</routing_intelligence>

<quality_standards>
  <xml_optimization>
    All generated agents must follow research-backed XML patterns:
    - Optimal component ordering (context→role→task→instructions)
    - Hierarchical context structure
    - Clear workflow stages with checkpoints
    - @ symbol routing for subagents
    - Context level specification for all routes
  </xml_optimization>
  
  <modular_organization>
    Context files must be modular and focused:
    - 50-200 lines per file
    - Single responsibility per file
    - Clear naming conventions
    - Documented dependencies
  </modular_organization>
  
  <production_ready>
    Generated systems must be immediately usable:
    - Complete documentation
    - Working examples
    - Testing checklist
    - Clear next steps
  </production_ready>
  
  <performance_optimized>
    Systems must implement efficiency patterns:
    - 3-level context allocation
    - Manager-worker routing
    - Validation gates
    - Error handling
  </performance_optimized>
</quality_standards>
