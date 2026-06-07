/**
 * Project Selection Validator
 * 
 * Provides validation utilities for ensuring proper project selection
 * before graph operations and other project-specific actions.
 */

export interface ProjectValidationResult {
  isValid: boolean;
  projectExists: boolean;
  hasFiles: boolean;
  isAccessible: boolean;
  errorMessage?: string;
  suggestedAction?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path?: string;
  selected?: boolean;
}

/**
 * Validate that a project is properly selected and accessible for graph operations
 */
export function validateProject(projectId: string | null): ProjectValidationResult {
  // Check if project ID is provided
  if (!projectId || projectId.trim() === '') {
    return {
      isValid: false,
      projectExists: false,
      hasFiles: false,
      isAccessible: false,
      errorMessage: 'No project selected',
      suggestedAction: 'Please select a project from the sidebar before generating a knowledge graph'
    };
  }

  // For now, assume project exists if ID is provided
  // In a full implementation, this would check the actual project directory
  return {
    isValid: true,
    projectExists: true,
    hasFiles: true,
    isAccessible: true
  };
}

/**
 * Get the currently selected project from the UI
 */
export function getCurrentProject(): ProjectInfo | null {
  // Check for selected project in the UI
  const selectedProjectEl = document.querySelector('.project-item.selected');
  if (selectedProjectEl) {
    const projectId = selectedProjectEl.getAttribute('data-project-id');
    const projectName = selectedProjectEl.querySelector('.project-name')?.textContent || 'Unknown';
    
    if (projectId) {
      return {
        id: projectId,
        name: projectName,
        selected: true
      };
    }
  }

  // Check if there's a project ID in the URL or stored state
  const urlParams = new URLSearchParams(window.location.search);
  const projectId = urlParams.get('project');
  
  if (projectId) {
    return {
      id: projectId,
      name: 'Current Project',
      selected: true
    };
  }

  return null;
}

/**
 * Show project selection prompt to the user
 */
export function showProjectSelectionPrompt(): void {
  const message = `
🔗 Generate Knowledge Graph

Please select a project first before generating a knowledge graph.

Steps:
1. Click on a project in the sidebar to select it
2. Right-click the selected project
3. Choose "🔗 Generate Knowledge Graph"

Knowledge graphs analyze your project's code structure and show relationships between components.
  `.trim();

  alert(message);
}

/**
 * Show project validation error with helpful guidance
 */
export function showProjectValidationError(result: ProjectValidationResult): void {
  if (result.isValid) {
    return; // No error to show
  }

  let message = '❌ Knowledge Graph Generation Failed\n\n';
  
  if (result.errorMessage) {
    message += `Error: ${result.errorMessage}\n\n`;
  }

  if (result.suggestedAction) {
    message += `Solution: ${result.suggestedAction}\n\n`;
  }

  if (!result.projectExists) {
    message += 'Troubleshooting:\n';
    message += '• Make sure you have created a project\n';
    message += '• Check that the project appears in the sidebar\n';
    message += '• Try refreshing the application\n';
  } else if (!result.hasFiles) {
    message += 'Troubleshooting:\n';
    message += '• Add some code files to your project\n';
    message += '• Supported file types: .ts, .js, .py, .java, .go, .rs, .cpp, .c, .md\n';
    message += '• Make sure files are not empty\n';
  } else if (!result.isAccessible) {
    message += 'Troubleshooting:\n';
    message += '• Check file permissions for the project directory\n';
    message += '• Make sure the project path is accessible\n';
    message += '• Try restarting NeuroNest\n';
  }

  alert(message);
}

/**
 * Validate project selection before any graph operation
 */
export function validateProjectForGraphOperation(): { isValid: boolean; projectId?: string; projectName?: string } {
  const currentProject = getCurrentProject();
  
  if (!currentProject) {
    showProjectSelectionPrompt();
    return { isValid: false };
  }

  const validation = validateProject(currentProject.id);
  
  if (!validation.isValid) {
    showProjectValidationError(validation);
    return { isValid: false };
  }

  return {
    isValid: true,
    projectId: currentProject.id,
    projectName: currentProject.name
  };
}

/**
 * Enhanced project validation with file system checks
 */
export async function validateProjectWithFileSystem(projectId: string): Promise<ProjectValidationResult> {
  try {
    // Use the existing eapi to check project status
    const eapi = (window as any).electronAPI;
    if (!eapi) {
      return {
        isValid: false,
        projectExists: false,
        hasFiles: false,
        isAccessible: false,
        errorMessage: 'Electron API not available',
        suggestedAction: 'Try restarting the application'
      };
    }

    // Check if project has files
    try {
      const files = await eapi.invoke('get-project-files', { projectId });
      
      if (!files || files.length === 0) {
        return {
          isValid: false,
          projectExists: true,
          hasFiles: false,
          isAccessible: true,
          errorMessage: 'Project has no files to analyze',
          suggestedAction: 'Add some code files to your project (.ts, .js, .py, .java, .go, .rs, .cpp, .c, .md)'
        };
      }

      return {
        isValid: true,
        projectExists: true,
        hasFiles: true,
        isAccessible: true
      };

    } catch (fileError) {
      return {
        isValid: false,
        projectExists: true,
        hasFiles: false,
        isAccessible: false,
        errorMessage: 'Cannot access project files',
        suggestedAction: 'Check project permissions and try again'
      };
    }

  } catch (error) {
    return {
      isValid: false,
      projectExists: false,
      hasFiles: false,
      isAccessible: false,
      errorMessage: 'Project validation failed',
      suggestedAction: 'Make sure the project exists and is accessible'
    };
  }
}