/**
 * Compact, reviewed subset of the normative A2A v1.0.0 protobuf schema used
 * here. Field names are the ProtoJSON spellings.
 */
export const A2A_V1_SUBSET_FIXTURE = {
  specification: 'https://a2a-protocol.org/v1.0.0/specification/',
  schemaSource: 'https://raw.githubusercontent.com/a2aproject/A2A/v1.0.0/specification/a2a.proto',
  specificationRevision: '1.0.0',
  protocolVersion: '1.0',
  binding: 'JSONRPC',
  methods: ['SendMessage', 'GetTask'],
  pushNotificationMethods: [
    'CreateTaskPushNotificationConfig',
    'GetTaskPushNotificationConfig',
    'ListTaskPushNotificationConfigs',
    'DeleteTaskPushNotificationConfig',
  ],
  unsupportedMethods: [
    'SendStreamingMessage',
    'ListTasks',
    'CancelTask',
    'SubscribeToTask',
    'CreateTaskPushNotificationConfig',
    'GetTaskPushNotificationConfig',
    'ListTaskPushNotificationConfigs',
    'DeleteTaskPushNotificationConfig',
    'GetExtendedAgentCard',
  ],
  errors: {
    taskNotFound: -32001,
    pushNotificationNotSupported: -32003,
    unsupportedOperation: -32004,
    contentTypeNotSupported: -32005,
    versionNotSupported: -32009,
  },
  agentCard: {
    required: [
      'name', 'description', 'supportedInterfaces', 'version', 'capabilities',
      'defaultInputModes', 'defaultOutputModes', 'skills',
    ],
    interfaceRequired: ['url', 'protocolBinding', 'protocolVersion'],
    interfaceTenantField: 'tenant',
    securitySchemeUnionField: 'mtlsSecurityScheme',
    securityRequirementMapField: 'schemes',
  },
} as const;
