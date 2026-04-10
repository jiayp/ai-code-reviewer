# @buxuku/ai-code-reviewer

## 介绍

![](preview.png)

`@buxuku/ai-code-reviewer` 是一款应用于 GitLab Merge Request 代码审查的小工具，支持调用私有化部署的 GitLab API，并使用 OpenAI API 获取审查结果。请注意，在使用它时，需要确保符合公司合规要求。😉


## 特点

- 🛠️ 支持配置 GitLab API 地址
- 🌍 支持配置 OpenAI 代理 API 地址，解决国内可能无法访问 OpenAI API 的问题
- 🆔 支持配置 OpenAI 组织 ID
- ⚙️ 支持配置多个 OpenAI API Key 实现接口调用的负载均衡（多个 Key 以逗号分隔）
- 🚦 超过速率限制时，自动等待并重试
- 💬 审查结果以评论的方式追加到对应的代码块所在位置


## 安装

```sh
npm i @buxuku/ai-code-reviewer
```

## 配置

项目支持通过 TOML 或 JSON 配置文件进行配置。默认配置文件名为 `ai-code-reviewer.config.toml`，位于项目根目录。

### TOML 配置文件格式

```toml
[gitlab]
apiUrl = "https://gitlab.com/api/v4"
accessToken = ""
projectId = 0
mergeRequestId = ""

[openai]
apiUrl = "https://api.openai.com"
accessToken = ""
model = "gpt-3.5-turbo"
organizationId = ""
temperature = 0.0
stream = false

[prompts]
systemContent = """
你是一位资深的软件架构与代码设计审查专家。
因为主业务流程测试已经覆盖，所以你更关注代码的长期健康度。
你的核心使命是发现：架构耦合过紧、扩展性瓶颈、并发资源竞争、
内存/连接泄漏、错误吞没、事务边界不当等短期测试难以暴露的隐患。
"""
suggestContent = """
接下来，我会发送本次合并请求的 git diff 格式补丁。
你的审查任务如下：
- **仅审查 diff 中实际修改的代码行**，严禁展开分析未修改的周边上下文。
- 代码已通过编译和 Lint 检查且能成功运行，因此**忽略语法、格式和未使用变量类问题**。
- **聚焦于隐患**：聚焦于测试不易发现的隐患。
- **聚焦于设计和代码质量问题**：仅当发现明确的设计和代码质量问题时才报告。
- **给出修改建议**
- **不确定性禁止输出**：凡包含"或许"、"可能"的语句一律删除。
- **若无有效问题，仅回复数字 `666`**，不要输出任何解释性文字。
- 反馈必须使用中文，若有多个意见使用列表符号，无需解释代码原本的功能。

以下是本次提交的变更内容：
"""
fullContent = """
第一步，以下是该文件的完整修订文本。
请仔细理解该文件内的代码逻辑，以便为后续的 diff 片段提供准确的上下文锚点：
"""
```

### JSON 配置文件格式（兼容）

项目也支持 JSON 格式的配置文件，格式与 TOML 相同。

### 配置优先级

1. 命令行参数优先级最高，会覆盖配置文件中的设置
2. 配置文件：首先查找 `ai-code-reviewer.config.toml`，如果不存在则查找 `ai-code-reviewer.config.json`
3. 如果配置文件不存在或某项配置缺失，则使用默认值

### 自定义配置文件路径

```sh
ai-code-reviewer -c /path/to/your/config.toml -p 432288 -r 8
```

## 使用

### 通过 Shell 脚本使用

```shell
Usage: ai-code-reviewer [options]

Options:
  -c, --config <string>              Path to config file
  -g, --gitlab-api-url <string>      GitLab API URL
  -t, --gitlab-access-token <string> GitLab Access Token
  -o, --openai-api-url <string>      OpenAI API URL
  -a, --openai-access-token <string> OpenAI Access Token
  -p, --project-id <number>          GitLab Project ID
  -r, --merge-request-id <string>    GitLab Merge Request ID
  -m, --model <string>               OpenAI model name
  -org, --organization-id <string>   OpenAI organization ID
  --temperature <number>             OpenAI temperature setting
  -h, --help                         display help for command
```

### 使用配置文件

如果有配置文件，只需要指定必要的参数：

```sh
ai-code-reviewer -p 432288 -r 8
```

### 命令行覆盖配置

```sh
ai-code-reviewer -c /path/to/config.json -m gpt-4 --temperature 0.5
```

### 在 CI 中使用

在 GitLab CI/CD 中设置变量，`.gitlab-ci.yml` 如下：

```yml
stages:
  - merge-request

Code Review:
  stage: merge-request
  image: node:latest
  script:
    - npm i @buxuku/ai-code-reviewer -g
    - ai-code-reviewer -t "$GITLAB_TOKEN" -a "$CHATGPT_KEY" -p "$CI_MERGE_REQUEST_PROJECT_ID" -r "$CI_MERGE_REQUEST_IID"
  only:
    - merge_requests
  when: on_success
```

## 贡献
欢迎贡献代码，提出问题和建议！👏

## 许可证
本项目基于 MIT 许可证。详细信息请参见 LICENSE 文件。📜