/**
 * WebSocket Integration Example
 * 
 * Demonstrates how to use the WebSocket client for real-time Agent Skills updates
 * in the renderer process.
 */

import { createWebSocketClient, type AgentSkillsWebSocketClient, ConnectionState } from './websocket-client.js';

/**
 * Example usage of WebSocket client for Agent Skills real-time updates
 */
export class AgentSkillsRealtimeExample {
  private wsClient: AgentSkillsWebSocketClient;
  private isInitialized = false;

  constructor() {
    // Create WebSocket client with custom configuration
    this.wsClient = createWebSocketClient({
      url: 'ws://localhost:3001/agent-skills-ws',
      reconnectInterval: 3000,
      maxReconnectAttempts: 5,
      pingInterval: 25000,
      connectionTimeout: 8000
    });

    this.setupEventHandlers();
  }

  /**
   * Initialize the WebSocket connection and subscriptions
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log('WebSocket client already initialized');
      return;
    }

    try {
      // Connect to WebSocket server
      await this.wsClient.connect();
      
      // Subscribe to skill-related events
      this.subscribeToSkillEvents();
      
      this.isInitialized = true;
      console.log('Agent Skills WebSocket client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize WebSocket client:', error);
      throw error;
    }
  }

  /**
   * Cleanup and disconnect
   */
  cleanup(): void {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.isInitialized = false;
      console.log('Agent Skills WebSocket client cleaned up');
    }
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    // Connection state changes
    this.wsClient.on('stateChange', (state: ConnectionState) => {
      console.log('WebSocket connection state changed:', state);
      
      // Update UI based on connection state
      this.updateConnectionStatus(state);
    });

    // Connection established
    this.wsClient.on('connected', () => {
      console.log('WebSocket connected successfully');
      this.onConnected();
    });

    // Connection lost
    this.wsClient.on('disconnected', () => {
      console.log('WebSocket disconnected');
      this.onDisconnected();
    });

    // Reconnection attempts
    this.wsClient.on('reconnecting', (attempt: number) => {
      console.log(`WebSocket reconnecting... attempt ${attempt}`);
      this.onReconnecting(attempt);
    });

    // Connection errors
    this.wsClient.on('error', (error: any) => {
      console.error('WebSocket error:', error);
      this.onError(error);
    });
  }

  /**
   * Subscribe to skill-related events
   */
  private subscribeToSkillEvents(): void {
    // Subscribe to skill creation events
    this.wsClient.subscribe(['skill.created'], (event) => {
      console.log('Skill created:', event);
      this.onSkillCreated(event);
    });

    // Subscribe to skill updates
    this.wsClient.subscribe(['skill.updated'], (event) => {
      console.log('Skill updated:', event);
      this.onSkillUpdated(event);
    });

    // Subscribe to skill assignments
    this.wsClient.subscribe(['skill.assigned'], (event) => {
      console.log('Skill assigned:', event);
      this.onSkillAssigned(event);
    });

    // Subscribe to performance updates
    this.wsClient.subscribe(['skill.performance.updated'], (event) => {
      console.log('Skill performance updated:', event);
      this.onSkillPerformanceUpdated(event);
    });

    // Subscribe to all agent-related events with wildcard
    this.wsClient.subscribe(['agent.*'], (event) => {
      console.log('Agent event:', event);
      this.onAgentEvent(event);
    });

    console.log('Subscribed to skill events:', this.wsClient.getSubscriptions());
  }

  /**
   * Handle connection status updates
   */
  private updateConnectionStatus(state: ConnectionState): void {
    // Update UI connection indicator
    const statusElement = document.getElementById('ws-connection-status');
    if (statusElement) {
      statusElement.textContent = state;
      statusElement.className = `connection-status ${state}`;
    }

    // Show/hide reconnection indicator
    const reconnectElement = document.getElementById('ws-reconnecting');
    if (reconnectElement) {
      reconnectElement.style.display = state === ConnectionState.RECONNECTING ? 'block' : 'none';
    }
  }

  /**
   * Handle successful connection
   */
  private onConnected(): void {
    // Enable real-time features in UI
    this.enableRealtimeFeatures();
    
    // Show success notification
    this.showNotification('Real-time updates connected', 'success');
  }

  /**
   * Handle disconnection
   */
  private onDisconnected(): void {
    // Disable real-time features in UI
    this.disableRealtimeFeatures();
    
    // Show warning notification
    this.showNotification('Real-time updates disconnected', 'warning');
  }

  /**
   * Handle reconnection attempts
   */
  private onReconnecting(attempt: number): void {
    // Show reconnection progress
    this.showNotification(`Reconnecting... (attempt ${attempt})`, 'info');
  }

  /**
   * Handle connection errors
   */
  private onError(error: any): void {
    // Show error notification
    this.showNotification(`Connection error: ${error.message}`, 'error');
    
    // Disable real-time features
    this.disableRealtimeFeatures();
  }

  /**
   * Handle skill creation events
   */
  private onSkillCreated(event: any): void {
    // Update skills list in UI
    this.updateSkillsList();
    
    // Show notification
    this.showNotification(`New skill created: ${event.data?.skill?.name}`, 'success');
    
    // Trigger UI refresh if needed
    this.refreshSkillsView();
  }

  /**
   * Handle skill update events
   */
  private onSkillUpdated(event: any): void {
    // Update specific skill in UI
    this.updateSkillInList(event.data?.skill);
    
    // Show notification
    this.showNotification(`Skill updated: ${event.data?.skill?.name}`, 'info');
  }

  /**
   * Handle skill assignment events
   */
  private onSkillAssigned(event: any): void {
    // Update agent skills view
    this.updateAgentSkills(event.data?.assignment?.agentId);
    
    // Show notification
    const skillName = event.data?.assignment?.skillId;
    const agentId = event.data?.assignment?.agentId;
    this.showNotification(`Skill ${skillName} assigned to agent ${agentId}`, 'success');
  }

  /**
   * Handle skill performance update events
   */
  private onSkillPerformanceUpdated(event: any): void {
    // Update performance metrics in UI
    this.updatePerformanceMetrics(event.data);
    
    // Update charts or graphs if visible
    this.refreshPerformanceCharts();
  }

  /**
   * Handle general agent events
   */
  private onAgentEvent(event: any): void {
    // Handle various agent-related events
    console.log('Agent event received:', event);
    
    // Update agent status or information as needed
    this.updateAgentStatus(event);
  }

  /**
   * Enable real-time features in UI
   */
  private enableRealtimeFeatures(): void {
    // Enable live updates toggle
    const liveToggle = document.getElementById('live-updates-toggle') as HTMLInputElement;
    if (liveToggle) {
      liveToggle.disabled = false;
      liveToggle.checked = true;
    }

    // Show real-time indicators
    const indicators = document.querySelectorAll('.realtime-indicator');
    indicators.forEach(indicator => {
      (indicator as HTMLElement).style.display = 'inline';
    });
  }

  /**
   * Disable real-time features in UI
   */
  private disableRealtimeFeatures(): void {
    // Disable live updates toggle
    const liveToggle = document.getElementById('live-updates-toggle') as HTMLInputElement;
    if (liveToggle) {
      liveToggle.disabled = true;
      liveToggle.checked = false;
    }

    // Hide real-time indicators
    const indicators = document.querySelectorAll('.realtime-indicator');
    indicators.forEach(indicator => {
      (indicator as HTMLElement).style.display = 'none';
    });
  }

  /**
   * Show notification to user
   */
  private showNotification(message: string, type: 'success' | 'error' | 'warning' | 'info'): void {
    // Implementation would depend on your notification system
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    // Example: Create toast notification
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    const container = document.getElementById('notifications-container');
    if (container) {
      container.appendChild(notification);
      
      // Auto-remove after 5 seconds
      setTimeout(() => {
        if (notification.parentNode) {
          notification.parentNode.removeChild(notification);
        }
      }, 5000);
    }
  }

  /**
   * Update skills list in UI
   */
  private updateSkillsList(): void {
    // Trigger skills list refresh
    // This would typically call your skills management component
    console.log('Updating skills list...');
  }

  /**
   * Update specific skill in list
   */
  private updateSkillInList(skill: any): void {
    if (!skill) return;
    
    // Update specific skill item in UI
    const skillElement = document.getElementById(`skill-${skill.id}`);
    if (skillElement) {
      // Update skill display
      console.log('Updating skill in list:', skill.id);
    }
  }

  /**
   * Refresh skills view
   */
  private refreshSkillsView(): void {
    // Refresh the entire skills view if needed
    console.log('Refreshing skills view...');
  }

  /**
   * Update agent skills for specific agent
   */
  private updateAgentSkills(agentId: string): void {
    if (!agentId) return;
    
    // Update agent skills display
    console.log('Updating agent skills for:', agentId);
  }

  /**
   * Update performance metrics
   */
  private updatePerformanceMetrics(data: any): void {
    // Update performance metrics display
    console.log('Updating performance metrics:', data);
  }

  /**
   * Refresh performance charts
   */
  private refreshPerformanceCharts(): void {
    // Refresh charts or graphs
    console.log('Refreshing performance charts...');
  }

  /**
   * Update agent status
   */
  private updateAgentStatus(event: any): void {
    // Update agent status display
    console.log('Updating agent status:', event);
  }

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.wsClient.getState();
  }

  /**
   * Get active subscriptions
   */
  getSubscriptions(): string[] {
    return this.wsClient.getSubscriptions();
  }

  /**
   * Manually test WebSocket connectivity
   */
  async testConnection(): Promise<boolean> {
    try {
      if (this.wsClient.getState() !== ConnectionState.CONNECTED) {
        await this.wsClient.connect();
      }
      return true;
    } catch (error) {
      console.error('WebSocket connection test failed:', error);
      return false;
    }
  }
}

/**
 * Initialize Agent Skills real-time updates
 * Call this from your main application initialization
 */
export async function initializeAgentSkillsRealtime(): Promise<AgentSkillsRealtimeExample> {
  const realtimeClient = new AgentSkillsRealtimeExample();
  await realtimeClient.initialize();
  return realtimeClient;
}

/**
 * Example of using WebSocket client with IPC fallback
 * This shows how to integrate WebSocket with existing IPC system
 */
export class HybridRealtimeClient {
  private wsClient: AgentSkillsWebSocketClient;
  private useWebSocket = true;

  constructor() {
    this.wsClient = createWebSocketClient();
    
    // Try WebSocket first, fallback to IPC if needed
    this.wsClient.on('error', () => {
      console.warn('WebSocket failed, falling back to IPC updates');
      this.useWebSocket = false;
      this.setupIPCFallback();
    });
  }

  /**
   * Subscribe to updates using WebSocket or IPC
   */
  async subscribeToUpdates(topics: string[]): Promise<void> {
    if (this.useWebSocket) {
      try {
        await this.wsClient.connect();
        this.wsClient.subscribe(topics, (event) => {
          this.handleRealtimeUpdate(event);
        });
      } catch (error) {
        console.warn('WebSocket subscription failed, using IPC');
        this.useWebSocket = false;
        this.setupIPCFallback();
      }
    }
    
    if (!this.useWebSocket) {
      // Use IPC for updates
      await this.subscribeViaIPC(topics);
    }
  }

  /**
   * Setup IPC fallback for real-time updates
   */
  private setupIPCFallback(): void {
    // Use existing IPC system for updates
    // Note: This would require proper electronAPI types in a real implementation
    console.log('Setting up IPC fallback for real-time updates');
  }

  /**
   * Subscribe via IPC
   */
  private async subscribeViaIPC(topics: string[]): Promise<void> {
    // Note: This would require proper electronAPI types in a real implementation
    console.log('Subscribing via IPC to topics:', topics);
  }

  /**
   * Handle real-time updates from either WebSocket or IPC
   */
  private handleRealtimeUpdate(data: any): void {
    console.log('Real-time update received:', data);
    // Handle the update regardless of source
  }
}