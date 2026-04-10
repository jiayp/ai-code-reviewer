# @buxuku/ai-code-reviewer

## 介绍

![](preview.png)

`@kiol/ai-code-reviewer` 是一款应用于 GitLab Merge Request 代码审查的小工具，支持调用私有化部署的 GitLab API，并使用OpenAI兼容API获取审查结果。请注意，在使用它时，需要确保符合公司合规要求。😉


## 特点

- 🛠️ 支持配置 GitLab API 地址
- 🌍 支持配置OpenAI兼容API地址，支持不同大模型提供商。
- 🆔 支持配置 OpenAI 组织 ID
- ⚙️ 支持配置多个API Key 实现接口调用的负载均衡（多个 Key 以逗号分隔）
- 🚦 超过速率限制时，自动等待并重试
- 💬 审查结果以评论的方式追加到对应的代码块所在位置


## 安装

```sh
npm i @kiol/ai-code-reviewer
```

## 配置

项目支持通过 TOML 或 JSON 配置文件进行配置。默认配置文件名为 `ai-code-reviewer.config.toml`，位于项目根目录。

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
    - npm i @kiol/ai-code-reviewer -g
    - ai-code-reviewer -t "$GITLAB_TOKEN" -a "$CHATGPT_KEY" -p "$CI_MERGE_REQUEST_PROJECT_ID" -r "$CI_MERGE_REQUEST_IID"
  only:
    - merge_requests
  when: on_success
```

## 贡献
欢迎贡献代码，提出问题和建议！👏

## 许可证
本项目基于 MIT 许可证。详细信息请参见 LICENSE 文件。📜