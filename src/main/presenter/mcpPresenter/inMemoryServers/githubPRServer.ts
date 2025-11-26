import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import axios from 'axios'

// Schema definitions
const CreatePullRequestArgsSchema = z.object({
  owner: z.string().describe('Repository owner (username or organization)'),
  repo: z.string().describe('Repository name'),
  title: z.string().describe('Pull request title'),
  body: z.string().optional().describe('Pull request description/body'),
  head: z.string().describe('The name of the branch where your changes are implemented'),
  base: z.string().describe('The name of the branch you want the changes pulled into'),
  draft: z.boolean().optional().default(false).describe('Whether to create a draft pull request')
})

const ListRepositoriesArgsSchema = z.object({
  type: z
    .enum(['all', 'owner', 'public', 'private', 'member'])
    .optional()
    .default('all')
    .describe('Type of repositories to list'),
  sort: z
    .enum(['created', 'updated', 'pushed', 'full_name'])
    .optional()
    .default('updated')
    .describe('Sort field'),
  per_page: z.number().optional().default(30).describe('Number of results per page (max 100)')
})

const ListBranchesArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  per_page: z.number().optional().default(30).describe('Number of results per page (max 100)')
})

const GetRepositoryArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name')
})

const ListPullRequestsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  state: z
    .enum(['open', 'closed', 'all'])
    .optional()
    .default('open')
    .describe('Filter by state'),
  per_page: z.number().optional().default(30).describe('Number of results per page (max 100)')
})

// Response interfaces
interface GitHubRepository {
  id: number
  name: string
  full_name: string
  description: string | null
  html_url: string
  private: boolean
  default_branch: string
  updated_at: string
  pushed_at: string
  language: string | null
  stargazers_count: number
  forks_count: number
}

interface GitHubBranch {
  name: string
  commit: {
    sha: string
    url: string
  }
  protected: boolean
}

interface GitHubPullRequest {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  user: {
    login: string
  }
  head: {
    ref: string
    sha: string
  }
  base: {
    ref: string
    sha: string
  }
  created_at: string
  updated_at: string
  merged_at: string | null
  draft: boolean
}

export class GitHubPRServer {
  private server: Server
  private token: string

  constructor(env?: Record<string, unknown>) {
    if (!env?.token) {
      throw new Error('Authentication configuration is required')
    }
    this.token = env.token as string

    // Create server instance
    this.server = new Server(
      {
        name: 'deepchat-inmemory/github-pr-server',
        version: '0.1.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    // Setup request handlers
    this.setupRequestHandlers()
  }

  // Start server
  public startServer(transport: Transport): void {
    this.server.connect(transport)
  }

  // Build query string from parameters
  private buildQueryString(params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        query.append(key, String(value))
      }
    }
    return query.toString()
  }

  // GitHub API request helper
  private async githubRequest<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    endpoint: string,
    data?: Record<string, unknown>
  ): Promise<T> {
    const url = `https://api.github.com${endpoint}`
    const response = await axios({
      method,
      url,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'DeepChat-GitHub-PR-Server',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      data
    })
    return response.data as T
  }

  // Create pull request
  private async createPullRequest(params: {
    owner: string
    repo: string
    title: string
    body?: string
    head: string
    base: string
    draft?: boolean
  }): Promise<GitHubPullRequest> {
    const endpoint = `/repos/${params.owner}/${params.repo}/pulls`
    return await this.githubRequest<GitHubPullRequest>('POST', endpoint, {
      title: params.title,
      body: params.body || '',
      head: params.head,
      base: params.base,
      draft: params.draft || false
    })
  }

  // List repositories for authenticated user
  private async listRepositories(params: {
    type?: string
    sort?: string
    per_page?: number
  }): Promise<GitHubRepository[]> {
    const queryStr = this.buildQueryString({
      type: params.type,
      sort: params.sort,
      per_page: params.per_page
    })
    return await this.githubRequest<GitHubRepository[]>('GET', `/user/repos?${queryStr}`)
  }

  // List branches for a repository
  private async listBranches(params: {
    owner: string
    repo: string
    per_page?: number
  }): Promise<GitHubBranch[]> {
    const queryStr = this.buildQueryString({ per_page: params.per_page })
    return await this.githubRequest<GitHubBranch[]>(
      'GET',
      `/repos/${params.owner}/${params.repo}/branches?${queryStr}`
    )
  }

  // Get repository details
  private async getRepository(params: {
    owner: string
    repo: string
  }): Promise<GitHubRepository> {
    return await this.githubRequest<GitHubRepository>(
      'GET',
      `/repos/${params.owner}/${params.repo}`
    )
  }

  // List pull requests for a repository
  private async listPullRequests(params: {
    owner: string
    repo: string
    state?: string
    per_page?: number
  }): Promise<GitHubPullRequest[]> {
    const queryStr = this.buildQueryString({
      state: params.state,
      per_page: params.per_page
    })
    return await this.githubRequest<GitHubPullRequest[]>(
      'GET',
      `/repos/${params.owner}/${params.repo}/pulls?${queryStr}`
    )
  }

  // Setup request handlers
  private setupRequestHandlers(): void {
    // Setup tool list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'github_create_pull_request',
            description:
              'Create a new pull request on GitHub. ' +
              'This tool allows you to submit changes from one branch to another. ' +
              'You need to specify the repository owner, repository name, title, ' +
              'the source branch (head) containing your changes, and the target branch (base) ' +
              'where you want the changes merged. Optionally, you can add a description and create it as a draft.',
            inputSchema: zodToJsonSchema(CreatePullRequestArgsSchema)
          },
          {
            name: 'github_list_repositories',
            description:
              'List repositories for the authenticated GitHub user. ' +
              'Returns repository information including name, description, URL, ' +
              'default branch, and statistics like stars and forks. ' +
              'You can filter by repository type and sort the results.',
            inputSchema: zodToJsonSchema(ListRepositoriesArgsSchema)
          },
          {
            name: 'github_list_branches',
            description:
              'List branches for a specified GitHub repository. ' +
              'Returns branch names, commit SHA, and protection status. ' +
              'Useful for finding available branches before creating a pull request.',
            inputSchema: zodToJsonSchema(ListBranchesArgsSchema)
          },
          {
            name: 'github_get_repository',
            description:
              'Get detailed information about a specific GitHub repository. ' +
              'Returns repository details including description, default branch, ' +
              'visibility, language, and various statistics.',
            inputSchema: zodToJsonSchema(GetRepositoryArgsSchema)
          },
          {
            name: 'github_list_pull_requests',
            description:
              'List pull requests for a specified GitHub repository. ' +
              'Returns pull request information including number, title, state, ' +
              'source and target branches, and author. You can filter by state (open/closed/all).',
            inputSchema: zodToJsonSchema(ListPullRequestsArgsSchema)
          }
        ]
      }
    })

    // Setup tool call handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params

        switch (name) {
          case 'github_create_pull_request': {
            const parsed = CreatePullRequestArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid parameters: ${parsed.error}`)
            }

            const pr = await this.createPullRequest(parsed.data)

            return {
              content: [
                {
                  type: 'text',
                  text:
                    `Successfully created pull request #${pr.number}\n\n` +
                    `**Title:** ${pr.title}\n` +
                    `**URL:** ${pr.html_url}\n` +
                    `**State:** ${pr.draft ? 'Draft' : pr.state}\n` +
                    `**Branch:** ${pr.head.ref} → ${pr.base.ref}`
                }
              ]
            }
          }

          case 'github_list_repositories': {
            const parsed = ListRepositoriesArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid parameters: ${parsed.error}`)
            }

            const repos = await this.listRepositories(parsed.data)

            const repoList = repos
              .map(
                (repo) =>
                  `- **${repo.full_name}**${repo.private ? ' (private)' : ''}\n` +
                  `  ${repo.description || 'No description'}\n` +
                  `  ⭐ ${repo.stargazers_count} | 🍴 ${repo.forks_count} | ` +
                  `${repo.language || 'Unknown language'} | ` +
                  `Default branch: ${repo.default_branch}`
              )
              .join('\n\n')

            return {
              content: [
                {
                  type: 'text',
                  text: `Found ${repos.length} repositories:\n\n${repoList}`
                }
              ]
            }
          }

          case 'github_list_branches': {
            const parsed = ListBranchesArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid parameters: ${parsed.error}`)
            }

            const branches = await this.listBranches(parsed.data)

            const branchList = branches
              .map(
                (branch) =>
                  `- **${branch.name}**${branch.protected ? ' 🔒' : ''}\n` +
                  `  Commit: ${branch.commit.sha.substring(0, 7)}`
              )
              .join('\n')

            return {
              content: [
                {
                  type: 'text',
                  text:
                    `Branches for ${parsed.data.owner}/${parsed.data.repo} (${branches.length}):\n\n${branchList}`
                }
              ]
            }
          }

          case 'github_get_repository': {
            const parsed = GetRepositoryArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid parameters: ${parsed.error}`)
            }

            const repo = await this.getRepository(parsed.data)

            return {
              content: [
                {
                  type: 'text',
                  text:
                    `**${repo.full_name}**${repo.private ? ' (private)' : ''}\n\n` +
                    `${repo.description || 'No description'}\n\n` +
                    `- **URL:** ${repo.html_url}\n` +
                    `- **Default branch:** ${repo.default_branch}\n` +
                    `- **Language:** ${repo.language || 'Unknown'}\n` +
                    `- **Stars:** ${repo.stargazers_count}\n` +
                    `- **Forks:** ${repo.forks_count}\n` +
                    `- **Last pushed:** ${repo.pushed_at}`
                }
              ]
            }
          }

          case 'github_list_pull_requests': {
            const parsed = ListPullRequestsArgsSchema.safeParse(args)
            if (!parsed.success) {
              throw new Error(`Invalid parameters: ${parsed.error}`)
            }

            const prs = await this.listPullRequests(parsed.data)

            if (prs.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No pull requests found for ${parsed.data.owner}/${parsed.data.repo}`
                  }
                ]
              }
            }

            const prList = prs
              .map(
                (pr) =>
                  `- **#${pr.number}** ${pr.title}${pr.draft ? ' (draft)' : ''}\n` +
                  `  ${pr.head.ref} → ${pr.base.ref} | By @${pr.user.login}\n` +
                  `  State: ${pr.state} | Created: ${pr.created_at.substring(0, 10)}`
              )
              .join('\n\n')

            return {
              content: [
                {
                  type: 'text',
                  text:
                    `Pull requests for ${parsed.data.owner}/${parsed.data.repo} (${prs.length}):\n\n${prList}`
                }
              ]
            }
          }

          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (error) {
        // Sanitize error messages to avoid exposing sensitive information
        let errorMessage = 'An error occurred while processing the request'
        if (error instanceof Error) {
          // Check for common API errors and provide generic messages
          const msg = error.message.toLowerCase()
          if (msg.includes('not found') || msg.includes('404')) {
            errorMessage = 'The requested resource was not found'
          } else if (msg.includes('unauthorized') || msg.includes('401')) {
            errorMessage = 'Authentication failed. Please check your credentials'
          } else if (msg.includes('forbidden') || msg.includes('403')) {
            errorMessage = 'Access denied. You may not have permission for this action'
          } else if (msg.includes('rate limit') || msg.includes('429')) {
            errorMessage = 'Rate limit exceeded. Please try again later'
          } else if (msg.includes('validation') || msg.includes('invalid')) {
            errorMessage = 'Invalid request parameters'
          } else if (msg.includes('unknown tool')) {
            errorMessage = error.message
          }
        }
        return {
          content: [{ type: 'text', text: `Error: ${errorMessage}` }],
          isError: true
        }
      }
    })
  }
}
