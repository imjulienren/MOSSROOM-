# 静态网页部署

项目已经是完整静态网页，无需后端或前端构建。发布目录为 `dist/`，入口为 `dist/index.html`。资源使用相对路径，支持 GitHub Pages 的仓库子路径。

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`：每次推送到 `main`，先运行音频测试，通过后上传 `dist/` 并部署到 GitHub Pages。也支持手动触发。

首次发布需要将仓库的 Pages 来源启用为 GitHub Actions。可以在 GitHub 的仓库设置中完成，也可以用 GitHub CLI 调用接口；不需要向任何聊天发送令牌。

在已安装 GitHub CLI 的终端中进行一次设备授权：

```sh
gh auth login --hostname github.com --git-protocol https --web
```

按终端提示自行完成授权，CLI 将凭据保存到本机支持的凭据存储。随后首次启用 Pages：

```sh
gh api --method POST repos/imjulienren/MOSSROOM-/pages -f build_type=workflow
gh workflow run pages.yml --repo imjulienren/MOSSROOM- --ref main
gh run list --repo imjulienren/MOSSROOM- --workflow pages.yml
```

如果 Pages 已经启用，先用 `gh api repos/imjulienren/MOSSROOM-/pages` 检查状态；需要切换来源时，将上面的 POST 改为 PUT。等待 Actions 的部署步骤成功后，通过 Pages 接口返回的 `html_url` 访问网页，不要仅凭源码上传成功判断部署成功。

## 其他静态托管

使用 Netlify、Cloudflare Pages 或其他静态主机时，发布目录设置为 `dist`，构建命令留空。无需服务器环境变量、数据库或 API 密钥。
