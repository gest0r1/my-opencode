# GitHub CLI Skill

## Overview
Автоматизация работы с GitHub через gh CLI.

## Authentication
```bash
gh auth status                                    # Проверить статус
echo "TOKEN" | gh auth login --with-token         # Войти с токеном
gh auth logout                                     # Выйти
```

## Repository Operations
```bash
gh repo create NAME --public --clone              # Создать репозиторий
gh repo clone OWNER/REPO                          # Клонировать
gh repo list OWNER --limit 20                     # Список
gh repo view OWNER/REPO                           # Информация
```

## Pull Requests
```bash
gh pr create --title "TITLE" --body "BODY"        # Создать PR
gh pr list --state open                           # Список открытых
gh pr merge NUMBER --merge                        # Merge
gh pr view NUMBER                                 # Статус
```

## Issues
```bash
gh issue create --title "TITLE" --body "BODY"     # Создать
gh issue list --state open                        # Список
gh issue close NUMBER                             # Закрыть
```

## Releases
```bash
gh release create v1.0.0 FILE.apk --title "v1.0.0" --notes "Notes"
gh release list
gh release download v1.0.0 --pattern "*.apk"
```

## API
```bash
gh api user                                       # Текущий пользователь
gh api repos/OWNER/REPO                           # Репозиторий
```

## Workflows

### Fork & Sync
```bash
gh repo clone OWNER/REPO
git remote add upstream https://github.com/ORIGINAL/REPO.git
git fetch upstream && git merge upstream/main
git push origin main
```

### Feature Branch → PR
```bash
git checkout -b feature/name
git add . && git commit -m "feat: description"
git push origin feature/name
gh pr create --title "feat: description" --body "Details"
```

### Release APK
```bash
./gradlew assembleRelease
gh release create v1.0.0 app/build/outputs/apk/release/app-release.apk --title "v1.0.0" --notes "Notes"
```

## Error Handling
| Error | Решение |
|-------|---------|
| HTTP 401: Bad credentials | Пересоздать токен |
| missing required scope | Пересоздать с нужными scopes |
| HTTP 404: Not Found | Проверить права доступа |
