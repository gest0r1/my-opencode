# CommandCreator patterns

<command_patterns>
  <simple_command>
    Single parameter, routes to one agent:
    /{command} "{input}"
  </simple_command>
  
  <parameterized_command>
    Multiple parameters with flags:
    /{command} {param1} {param2} --flag {value}
  </parameterized_command>
  
  <workflow_command>
    Triggers complete workflow:
    /{command} {input} --workflow {workflow_name}
  </workflow_command>
</command_patterns>
