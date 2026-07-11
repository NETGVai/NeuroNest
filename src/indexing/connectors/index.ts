/**
 * Multi-Source Connectors
 *
 * Pluggable modules that ingest non-source-code data into the Knowledge Graph.
 * Each connector implements the Connector interface with initialize(), ingest(),
 * and getNodes() methods.
 */

export { Connector, ConnectorNode, ConnectorEdge } from './connector-interface';

export { GitConnector } from './git-connector';
export { DocumentationConnector } from './documentation-connector';
export { ADRConnector } from './adr-connector';
