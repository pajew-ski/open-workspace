
import { WithContext, Project, Action, ItemList } from 'schema-dts';
import { OntologyConfig, GLOBAL_ASK_PERSON } from './types';

// Hardcoded config again, should be shared
const CONFIG: OntologyConfig = {
    baseUrl: 'https://exocortex.local',
    defaultLanguage: 'de',
    person: GLOBAL_ASK_PERSON
};

interface Task {
    id: string;
    title: string;
    status: string;
    projectId?: string;
    description?: string;
}

interface ProjectData {
    id: string;
    title: string;
    description?: string;
}

function mapStatus(status: string): string {
    // Schema.org ActionStatusType
    switch (status) {
        case 'done': return 'https://schema.org/CompletedActionStatus';
        case 'in-progress': return 'https://schema.org/ActiveActionStatus';
        default: return 'https://schema.org/PotentialActionStatus';
    }
}

export function generateProjectJsonLd(project: ProjectData, tasks: Task[]): WithContext<Project> {
    const url = `${CONFIG.baseUrl}/tasks?projectId=${project.id}`;

    // Filter tasks belonging to this project
    const projectTasks = tasks.filter(t => t.projectId === project.id);

    return {
        '@context': 'https://schema.org' as const,
        '@type': 'Project',
        '@id': url,
        url: url,
        name: project.title,
        description: project.description || `Projekt: ${project.title}`,
        // author: CONFIG.person, // Project (Organization) does not have author.
        member: CONFIG.person, // Person is a member of this Project
        hasPart: projectTasks.map(task => ({
            '@type': 'Action', // Using Action as generic Task representation
            name: task.title,
            description: task.description,
            actionStatus: mapStatus(task.status),
            agent: CONFIG.person
        }))
    } as any;
}

export function generateTaskListJsonLd(projects: ProjectData[], tasks: Task[]): WithContext<ItemList> {
    return {
        '@context': 'https://schema.org' as const,
        '@type': 'ItemList',
        name: 'Open Workspace Projekte',
        url: `${CONFIG.baseUrl}/tasks`,
        itemListElement: projects.map((proj, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: generateProjectJsonLd(proj, tasks)
        }))
    };
}
