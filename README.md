# API do NotasMAX — PostgreSQL

## Sobre o projeto

Este repositório contém a API do NotasMAX, construída com Azure Functions v4, Node.js 24 e TypeScript. O acesso ao PostgreSQL é feito com Knex e `pg`.

Atualmente, a API oferece `GET /api/v1/health`, as rotas de sessão administrativa, os fluxos compartilhados de ativação e recuperação de senha e os endpoints administrativos de contas de alunos, professores e administradores. A verificação de saúde confirma que a Function está respondendo e que consegue executar `SELECT 1` no PostgreSQL. As migrations criam o schema relacional inicial da V1 em uma base vazia; não há migração de dados do MongoDB. O primeiro administrador é criado somente quando o seed manual é executado.

A estrutura principal é:

```text
src/
├── database/       # conexão Knex/PostgreSQL e proteção de comandos locais
├── functions/      # registro das rotas Azure Functions
├── auth/           # sessões, autorização e ciclo/gestão administrativa de contas
└── health/         # verificação do banco e resposta de saúde da API
test/               # testes unitários e de integração
migrations/         # migrations forward-only do schema inicial V1
seed/               # seed manual e interativo do primeiro administrador
.github/workflows/  # validações automatizadas da CI
```

## Fluxo da verificação de saúde

```text
Cliente HTTP
    │ GET /api/v1/health
    ▼
Azure Function → manipulador de saúde → Knex/pg → PostgreSQL (SELECT 1)
    │                                      │
    ├── 200 { "status": "ok" } ◀──────────┘ consulta respondida
    └── 503 HEALTH_CHECK_UNAVAILABLE        falha ou tempo limite excedido
```

A rota não exige autenticação e deve permanecer limitada ao desenvolvimento e à integração contínua (CI) até que sua publicação seja autorizada. A verificação tem limite total de três segundos. Respostas e registros não expõem erros crus do banco, SQL, credenciais, corpos de requisição ou dados pessoais.

## Requisitos para executar localmente

- Node.js `24.21.0` e o npm incluído com ele.
- Docker Desktop com contêineres Linux (ou Docker Engine compatível) para iniciar o PostgreSQL.
- Azure Functions Core Tools v4; o comando `func` deve estar disponível no `PATH`.
- PowerShell no Windows, ou shell Bash no WSL/Linux.

Confira as versões instaladas:

```powershell
node --version
npm --version
docker --version
func --version
```

## Iniciar a API no Windows (PowerShell)

Execute os comandos na pasta deste repositório:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if (-not (Test-Path local.settings.json)) { Copy-Item local.settings.json.example local.settings.json }
npm ci
docker compose up -d postgres
npm run build
npm start -- --cors http://localhost:5173 --cors-credentials
```

A compilação com `npm run build` gera os arquivos JavaScript em `dist/`, de onde o ambiente do Azure Functions carrega a Function. Deixe o comando Core Tools acima em execução no terminal. Em outro terminal, consulte a rota:

```powershell
Invoke-RestMethod -Method Get -Uri 'http://localhost:7071/api/v1/health'
```

Com o PostgreSQL disponível, a resposta será:

```json
{"status":"ok"}
```

Para ver o código HTTP e o corpo bruto:

```powershell
Invoke-WebRequest -Method Get -Uri 'http://localhost:7071/api/v1/health'
```

## Iniciar pelo WSL/Linux

Na raiz do repositório:

```bash
test -f .env || cp .env.example .env
test -f local.settings.json || cp local.settings.json.example local.settings.json
npm ci
docker compose up -d postgres
npm run build
npm start -- --cors http://localhost:5173 --cors-credentials
```

Em outro terminal, consulte a rota:

```bash
curl -i http://localhost:7071/api/v1/health
```

## Configuração local

Os arquivos `.env` e `local.settings.json` são locais e ignorados pelo Git. Não coloque credenciais reais neles nem os versione.

| Variável | Uso | Valor de exemplo |
|---|---|---|
| `PGHOST` | Host do PostgreSQL | `127.0.0.1` |
| `PGPORT` | Porta do PostgreSQL | `5432` |
| `PGDATABASE` | Banco de desenvolvimento | `notasmax` |
| `PGUSER` | Usuário de desenvolvimento | `notasmax` |
| `PGPASSWORD` | Senha local de desenvolvimento | `local_dev_only` |
| `NOTASMAX_WEB_ORIGINS` | Origens exatas autorizadas para mutações com sessão | `http://localhost:5173` |
| `NODE_ENV` | Ambiente local/teste para habilitar o fake | `development` |
| `NOTASMAX_EMAIL_TRANSPORT` | Adaptador fake habilitado somente em desenvolvimento/teste local | `fake` |
| `NOTASMAX_WEB_BASE_URL` | Origem HTTPS usada nos links de ativação e redefinição | `https://localhost:5173` |

O Docker Compose lê `.env` para configurar o contêiner PostgreSQL. O Azure Functions Core Tools e o carregador de testes leem `local.settings.json`. Variáveis já definidas no ambiente do processo prevalecem sobre os exemplos locais.

O transporte `fake` apenas aceita a solicitação em memória: não entrega mensagens e não imprime nem retorna links ou tokens. Ele exige uma origem HTTPS, `NODE_ENV=development|test` e `NOTASMAX_EMAIL_TRANSPORT=fake`. No Functions Core Tools, permite `WEBSITE_HOSTNAME` apenas quando aponta para loopback; marcadores de instância/nome do Azure e hostnames externos continuam bloqueados. Não configure credenciais de provedor de e-mail nesta fase.

O PostgreSQL local escuta somente em `127.0.0.1:5432` e usa um volume Docker nomeado. Para parar o contêiner e preservar os dados locais:

```bash
docker compose down
```

Para remover também o volume e todos os dados locais do banco:

```bash
docker compose down -v
```

## CORS e sessão administrativa local

O website usa Vite, cuja porta local padrão é `5173`. Mantenha essa origem exata em `NOTASMAX_WEB_ORIGINS` no `local.settings.json` e na opção `--cors` do Core Tools, junto com `--cors-credentials`; não use `*`. Se o Vite iniciar em outra porta, atualize ambos os valores para a origem impressa pelo servidor. As origens devem coincidir exatamente, incluindo protocolo, host e porta.

As operações que iniciam e encerram sessões também validam `Origin` e exigem `X-Requested-With: XMLHttpRequest` no servidor. O cookie de sessão é `HttpOnly; Secure; SameSite=None`; o desenvolvimento local usa HTTP em `localhost`, mantendo `Secure`. A validação do cookie no Safari depende de um ambiente HTTPS. As origens HTTPS da Azure devem ser configuradas quando os endereços existirem; publicação e configuração Azure não fazem parte da execução local documentada.

## Ciclo de vida de conta

| Método e rota | Finalidade |
|---|---|
| `POST /api/v1/auth/password-reset-requests` | Solicita redefinição; a resposta `200` é genérica. Há no máximo três solicitações por conta em uma janela fixa de 24 horas. |
| `POST /api/v1/auth/password-resets` | Consome token de redefinição de uso único, válido por uma hora, define a senha e revoga sessões existentes. |
| `POST /api/v1/auth/activations` | Consome token de ativação de uso único, válido por 72 horas, define a senha escolhida e ativa a conta. |
| `POST /api/v1/admin/users/{userId}/activation-resends` | Reenvia a ativação para conta pendente, exige sessão administrativa, origem permitida e `X-Requested-With`; responde `activationEmailStatus: sent|failed`. |

Os tokens são aleatórios; somente hashes SHA-256 e expirações ficam no PostgreSQL. Cada nova emissão substitui o token anterior do mesmo fluxo. O contador e o início da janela de redefinição são campos aditivos em `usuario`, zerados após login bem-sucedido ou redefinição concluída. Um timer diário da própria Function App remove registros de token expirados. O transporte desta fase é exclusivamente `fake`; `sent` indica aceite pelo adaptador, não entrega. Links tokenizados não aparecem em logs ou respostas.

## Administração de contas

Todas as rotas `/api/v1/admin/*` abaixo exigem sessão ativa de administrador verificada no servidor. Toda mutação também exige `Origin` presente e permitido pela allowlist exata e `X-Requested-With: XMLHttpRequest`; as rejeições ocorrem antes de qualquer acesso ao banco. As respostas seguem RFC 9457 e não incluem erros crus do PostgreSQL.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/students` | Lista alunos; aceita `search`, `activationStatus`, `enrollmentStatus`, `classId`, `page` e `pageSize`. |
| `POST /api/v1/admin/students` | Cria aluno pendente e solicita uma tentativa de ativação. Campos: `name`, `email`, `guardianPhone` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/students/{studentId}` | Consulta dados e matrículas, edita campos cadastrais ou faz exclusão lógica. |
| `GET /api/v1/admin/teachers` | Lista professores; aceita `search`, `classId`, `subjectId`, `page` e `pageSize`. Quando turma e matéria são informadas juntas, devem corresponder à mesma associação existente. |
| `POST /api/v1/admin/teachers` | Cria professor pendente. Campos: `name`, `email` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/teachers/{teacherId}` | Consulta, edita ou faz exclusão lógica do professor. |
| `GET /api/v1/admin/classes/{classId}/subjects/{subjectId}/teachers` | Lista em `{ items: [{ teacherId, name, email, activationStatus }] }` os professores associados atualmente à matéria oferecida pela turma; não há paginação. |
| `PUT /api/v1/admin/classes/{classId}/subjects/{subjectId}/teachers/{teacherId}` | Adiciona a associação atual; permite vários professores e retorna `204`. Repetir a associação também retorna `204`. |
| `DELETE /api/v1/admin/classes/{classId}/subjects/{subjectId}/teachers/{teacherId}` | Remove somente a associação atual, sem excluir o professor nem manter histórico; retorna `204`, inclusive se a associação já estiver ausente. |
| `GET /api/v1/admin/administrators` | Lista administradores; aceita `search`, `page` e `pageSize`. |
| `POST /api/v1/admin/administrators` | Cria administrador pendente. Campos: `name`, `email` e `contactPhone` opcional. |
| `GET`, `PATCH`, `DELETE /api/v1/admin/administrators/{administratorId}` | Consulta, edita ou faz exclusão lógica do administrador. |

As três listas usam busca parcial sem diferenciar maiúsculas/minúsculas em nome ou e-mail, ordenação por nome crescente, `page` padrão `1`, `pageSize` padrão `20` (máximo `100`) e resposta `{ items, pagination: { page, pageSize, totalItems, totalPages } }`. A lista de alunos separa `activationStatus` (`pending`/`activated`) e `enrollmentStatus` (`active`/`no_active_enrollment`); inclui a turma vigente e `enrollmentId` quando houver. Detalhes retornam os telefones disponíveis; o detalhe do aluno inclui o histórico de matrículas.

Criações retornam `201` com `activationEmailStatus: sent|failed`; falha síncrona do transporte fake/local não desfaz o cadastro. E-mail duplicado retorna `409 EMAIL_ALREADY_IN_USE`. `PATCH` aceita campos parciais. Ao mudar o e-mail de outra conta, exige `currentPassword` da pessoa administradora que executa a operação; essa reautenticação usa o mesmo bloqueio de cinco falhas por conta em 15 minutos. O administrador não pode alterar o próprio e-mail por essa rota; a API retorna `422 VALIDATION_ERROR` com `errors[].code: INVALID_VALUE`. O e-mail institucional atual permanece até a pessoa confirmar o novo endereço pelo fluxo de ativação; enquanto isso, a conta fica pendente e não pode iniciar ou usar uma sessão. A alteração de `email_pendente` e a invalidação do token de ativação anterior ocorrem na mesma transação; o novo token e a mensagem são emitidos depois do commit. A API envia uma notificação sem token ao endereço anterior e um link de ativação ao endereço pendente. A confirmação promove o novo endereço e revoga as sessões existentes. Sem mudança de e-mail, a senha atual não é exigida.

Os eventos próprios da aplicação são emitidos somente quando `NODE_ENV=development`, pelo logger do contexto da Azure Function. Incluem mutações administrativas, reautenticação, health check, limpeza agendada e etapas de falha no cadastro; falhas na configuração de e-mail podem incluir somente códigos enumerados de motivo. Em produção, esses eventos da aplicação ficam desativados. Logs internos do host Azure Functions seguem a configuração do host. Senhas, tokens, corpo da requisição, dados pessoais desnecessários, valores de configuração e erros crus do PostgreSQL não são registrados. Os eventos da aplicação não são persistidos no banco de dados.

As exclusões são lógicas e revogam sessões sem apagar vínculos. O aluno só é bloqueado quando tem matrícula ativa e vínculo com simulado realizado (`409 STUDENT_CANNOT_BE_DELETED`); o professor é bloqueado enquanto houver associação a matéria/turma (`409 TEACHER_HAS_LINKED_DATA`). Administradores não podem excluir a própria conta (`409 ADMINISTRATOR_CANNOT_DELETE_SELF`) nem remover o último administrador ativo (`409 LAST_ACTIVE_ADMIN_CANNOT_BE_DELETED`). As mutações das associações validam a oferta turma/matéria e o perfil ativo do professor no servidor, são transacionais e não criam histórico. IDs inexistentes ou combinações incompatíveis retornam `404 RESOURCE_NOT_FOUND` com RFC 9457.

## Administração de matérias

Todas as rotas de matérias exigem sessão ativa de administrador. As mutações também exigem `Origin` permitido e `X-Requested-With: XMLHttpRequest`.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/subjects` | Lista matérias ativas. Aceita `search` por nome, `page` e `pageSize`; a ordenação é por nome crescente. |
| `POST /api/v1/admin/subjects` | Cria matéria com `name` obrigatório (até 120 caracteres) e `description` opcional (até 500). Retorna `201` com `{ subjectId, name, description }`. |
| `PATCH /api/v1/admin/subjects/{subjectId}` | Atualiza parcialmente `name` e/ou `description`; `description: null` limpa a descrição. Retorna `200` com o recurso atualizado. |
| `DELETE /api/v1/admin/subjects/{subjectId}` | Faz exclusão lógica e retorna `204`; a operação é idempotente. Vínculo com turma ativa retorna `409 SUBJECT_HAS_CLASS_LINKS`. |

A lista retorna `{ items: [{ subjectId, name, description }], pagination: { page, pageSize, totalItems, totalPages } }`, com `page=1`, `pageSize=20` e máximo de 100 itens por página. O nome é armazenado sem espaços externos; nomes de matérias ativas não podem se repetir sem diferença de maiúsculas/minúsculas. A duplicidade retorna `409 SUBJECT_ALREADY_EXISTS`; o nome pode ser reutilizado após a exclusão lógica. PATCH com corpo vazio retorna `422 VALIDATION_ERROR`; ID inexistente retorna `404 SUBJECT_NOT_FOUND`. Respostas de erro usam RFC 9457 e não expõem mensagens internas do PostgreSQL.

## Administração de turmas e ofertas de matérias

Todas as rotas abaixo exigem sessão ativa de administrador. As mutações também exigem `Origin` presente e permitido pela allowlist exata e `X-Requested-With: XMLHttpRequest`. As respostas de erro seguem RFC 9457 e não expõem erros crus do PostgreSQL.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/classes` | Lista turmas ativas por `schoolYear`, com paginação. O ano é opcional e, quando omitido, usa o ano-calendário atual. Cada item inclui `isClosed`, derivado de `turma.fechada_em IS NOT NULL`. |
| `GET /api/v1/admin/school-years` | Lista, em ordem decrescente e sem paginação, os anos letivos que têm turmas ativas. |
| `POST /api/v1/admin/classes` | Cria turma com `series` e `schoolYear`; retorna `201` com a representação básica da turma. |
| `GET /api/v1/admin/classes/{classId}` | Consulta os dados básicos da turma ativa, incluindo `isClosed`, derivado de `turma.fechada_em IS NOT NULL`. Retorna ETag forte para a representação pública. |
| `PATCH /api/v1/admin/classes/{classId}` | Atualiza parcialmente `series` e/ou `schoolYear`; retorna a representação básica da turma atualizada. Corpo vazio retorna `422 VALIDATION_ERROR`. |
| `DELETE /api/v1/admin/classes/{classId}` | Faz exclusão lógica e retorna `204`; repetir a exclusão também retorna `204`. |
| `GET /api/v1/admin/classes/{classId}/subjects` | Lista matérias ativas oferecidas à turma, sem paginação e em ordem crescente por nome. |
| `PUT /api/v1/admin/classes/{classId}/subjects/{subjectId}` | Associa matéria ativa à turma; operação idempotente, retorna `204`. |
| `DELETE /api/v1/admin/classes/{classId}/subjects/{subjectId}` | Remove a oferta e as associações atuais de professores; operação idempotente, retorna `204` quando a turma e a matéria estão ativas. |

Ao criar uma turma, `POST /api/v1/admin/classes` aceita opcionalmente `closeClassIds: [{ classId, etag }]` para fechar turmas elegíveis do ano letivo anterior. Para cada item, `etag` deve ser copiado exatamente do cabeçalho forte `ETag` de `GET /api/v1/admin/classes/{classId}` para a mesma turma. A resposta de detalhe expõe esse cabeçalho ao JavaScript (`Access-Control-Expose-Headers: ETag`) somente quando a origem já pertence à allowlist CORS. A lista de turmas não inclui ETags por item. O campo booleano `isClosed` não expõe a data de fechamento; o ETag forte do detalhe representa os campos públicos e muda quando o estado de fechamento muda. Turmas ausentes ou inelegíveis e ETags malformados, de outra turma ou desatualizados retornam `409 CLASS_SELECTION_INVALID`; o fechamento selecionado e a criação da nova turma são atômicos.

A lista de turmas retorna `{ items: [{ classId, series, schoolYear, startDate, isClosed }], pagination: { page, pageSize, totalItems, totalPages } }`, com `page=1`, `pageSize=20`, máximo de 100 itens e ordenação por ano letivo e série. O detalhe retorna os mesmos campos de turma e seu ETag forte. Somente essas respostas GET incluem `isClosed`: `true` quando `turma.fechada_em IS NOT NULL` e `false` caso contrário; a data/hora de fechamento não é exposta. As respostas de criação e atualização mantêm a representação básica `{ classId, series, schoolYear, startDate }`. `GET /api/v1/admin/school-years` retorna `{ items: [{ schoolYear }] }`. As séries aceitas são os inteiros `1`, `2` e `3`; o ano letivo é inteiro, sem limite temporal. Há uma turma ativa por combinação série/ano; a combinação pode ser reutilizada depois da exclusão lógica. Duplicidade ativa retorna `409 CLASS_ALREADY_EXISTS`.

O PATCH de série ou ano retorna `409 CLASS_HAS_LINKED_DATA` enquanto houver matrícula, oferta ou simulado vinculado. A exclusão lógica da turma é bloqueada por matrícula vigente na data da operação, oferta associada ou simulado ativo. Para esta regra, simulado ativo é aquele sem confirmação de realização e sem exclusão lógica; a data agendada não altera o estado. Matrículas encerradas ou canceladas, e simulados confirmados ou cancelados, não bloqueiam a exclusão da turma. IDs de turma inexistentes ou excluídos em operações por ID retornam `404 CLASS_NOT_FOUND`.

A oferta exige turma e matéria ativas; IDs inexistentes, excluídos ou incompatíveis retornam `404 RESOURCE_NOT_FOUND`. Um simulado com `instante_confirmacao_realizacao` preenchido bloqueia a remoção da matéria com `409 SUBJECT_HAS_COMPLETED_SIMULATIONS`. Em simulados sem confirmação, qualquer linha em `resultado` bloqueia a remoção com `409 SUBJECT_HAS_SIMULATION_RESULTS` e os resultados são preservados. Sem resultados, a API remove a matéria desses simulados, apaga somente as associações atuais de professores e remove a oferta na mesma transação. Cadastros de professores não são apagados nem há restauração ou histórico de associações.

A migration `202610100001_class_logical_deletion.js` adiciona `turma.excluido_em TIMESTAMPTZ` e substitui a unicidade geral de série/ano por um índice único parcial para turmas ativas. Migrations históricas não são alteradas.

## Administração de simulados

Todas as rotas exigem sessão ativa de administrador. As mutações também exigem `Origin` permitido e `X-Requested-With: XMLHttpRequest`. IDs de simulado são sempre limitados à turma informada no caminho. Respostas protegidas usam `Cache-Control: no-store`; erros seguem RFC 9457.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/classes/{classId}/simulations` | Lista simulados ativos com paginação e filtros opcionais `bimester`, `type`, `subjectId`, `fromDate` e `toDate`. |
| `POST /api/v1/admin/classes/{classId}/simulations` | Cria simulado e atribui o menor número positivo disponível na turma. Retorna `201`, representação e ETag forte. |
| `GET /api/v1/admin/classes/{classId}/simulations/{simulationId}` | Consulta a representação do simulado e seu ETag forte. |
| `PATCH /api/v1/admin/classes/{classId}/simulations/{simulationId}` | Atualiza `type`, `bimester`, `scheduledDate` e/ou `subjects`; exige o ETag atual em `If-Match`. |
| `POST /api/v1/admin/classes/{classId}/simulations/{simulationId}/realizations` | Confirma a realização, congela os alunos matriculados efetivamente na turma na data agendada e cria os resultados pendentes na mesma transação. Exige `If-Match`. |
| `DELETE /api/v1/admin/classes/{classId}/simulations/{simulationId}` | Faz exclusão lógica antes da confirmação e sem resultados vinculados; exige `If-Match` e retorna `204`. |

A lista retorna `{ items, pagination: { page, pageSize, totalItems, totalPages } }`, com `page=1`, `pageSize=20` e máximo de 100. A ordenação é estável por data agendada, número e ID. O corpo de criação contém `type` (`objetivo` ou `dissertativo`), `bimester` (1 a 4), `scheduledDate` (data civil) e `subjects`, com `subjectId`, `totalQuestions` positivo e `weightPercent` maior que zero e até 100. Pelo menos uma matéria atualmente oferecida à turma é obrigatória. Datas passadas são aceitas. Os pesos ativos da mesma matéria e bimestre não podem exceder 100%; uma alocação parcial representa média provisória.

PATCH, confirmação e exclusão retornam `428` sem `If-Match`, `400` para valor inválido e `412` para ETag desatualizado. O PATCH é permitido até a confirmação, inclusive após a data agendada. Turma fechada impede mutações e confirmação, mas mantém consultas históricas. A confirmação aceita zero alunos elegíveis. Tentativa de excluir simulado confirmado ou com resultados retorna `409 SIMULATION_HAS_LINKED_ANSWERS`.

## Administração de resultados

Todas as rotas exigem sessão ativa de administrador, verificam turma, simulado confirmado, participante congelado e matéria pertencente àquele simulado, e respondem com `Cache-Control: no-store`.

| Método e rota | Finalidade |
|---|---|
| `GET /api/v1/admin/classes/{classId}/simulations/{simulationId}/results` | Lista os resultados com paginação comum (`page=1`, `pageSize=20`, máximo 100); filtros opcionais: `subjectId`, `status` (`pending`, `assessed`, `absent`) e `search` por nome ou ID do aluno. |
| `GET /api/v1/admin/classes/{classId}/simulations/{simulationId}/results/{studentId}/{subjectId}` | Consulta um resultado e seu ETag forte. |
| `PATCH /api/v1/admin/classes/{classId}/simulations/{simulationId}/results/{studentId}/{subjectId}` | Atualiza estado/acertos; exige ETag forte atual no `If-Match`. |

As listas retornam `{ items, pagination: { page, pageSize, totalItems, totalPages } }`. Cada item usa camelCase: `simulationId`, `studentId`, `studentName`, `subjectId`, `subjectName`, `status`, `correctAnswers`, `totalQuestions`, `weightPercent`, `score` e `weightedContribution`. A representação individual é a mesma e seu ETag cobre todos esses campos. Nota avaliada é `(correctAnswers / totalQuestions) × 10`; contribuição ponderada é `score × weightPercent / 100`, mantendo precisão completa. Resultado pendente tem `score` e `weightedContribution` nulos. Ausência é explícita, tem `correctAnswers: null` e contribui com nota zero; zero acertos é uma nota avaliada válida.

O PATCH recebe `status`; ao usar `assessed`, também recebe `correctAnswers` inteiro entre zero e `totalQuestions`. As transições aceitas são `pending → assessed|absent`, `absent → assessed` e `assessed → assessed` para correção. `assessed → absent` é recusado. `If-Match` ausente retorna `428`, malformado ou fraco retorna `400`, e obsoleto retorna `412`. Conflitos de transição usam RFC 9457 `409`; estado de simulado não confirmado também retorna `409`. Não há histórico persistido das correções.

## Testes e verificações

Execute o lint, a verificação de tipos e a compilação:

```bash
npm run lint
npm run typecheck
npm run build
```

O lint usa ESLint com as regras recomendadas para JavaScript e TypeScript e cobre os arquivos mantidos de aplicação, testes, migrations, seed e tooling. Dependências instaladas e saídas geradas em `node_modules/`, `dist/` e `coverage/` são excluídas. A CI executa `npm run lint` como etapa obrigatória.

O lint é um controle complementar para consistência e problemas detectáveis pelas regras configuradas. O NIST SP 800-218 SSDF v1.1 cita linters como um exemplo para consistência de estilo e formatação (PW.5, Exemplo 7) e aborda análise e revisão de código separadamente em PW.7. Isso não significa que ESLint, sozinho, estabeleça conformidade de segurança ou substitua revisão humana, testes, análise de segurança ou auditoria de dependências. Consulte a [publicação do NIST](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-218.pdf) e a [documentação oficial do ESLint](https://eslint.org/docs/latest/about/).

Execute os testes unitários e de tratamento de erros:

```bash
npm test
```

Os testes de integração PostgreSQL são ignorados por padrão em `npm test`. Execute:

```bash
npm run test:integration
```

O comando exige PostgreSQL local em loopback e uma conta com permissão para criar bancos. Ele cria um banco descartável com nome gerado para a execução, aplica toda a sequência de migrations e remove somente esse banco ao terminar. O banco configurado para desenvolvimento não é usado como alvo de testes nem é removido. Para auditar as dependências registradas no arquivo de lock:

```bash
npm audit
```

## Resposta da verificação de saúde

| Situação | HTTP | Conteúdo |
|---|---:|---|
| API e PostgreSQL respondem | `200` | `{"status":"ok"}` |
| Banco indisponível, erro de conexão ou tempo limite excedido | `503` | Problema RFC 9457 com `code: HEALTH_CHECK_UNAVAILABLE` |

Os registros da invocação contêm somente evento, `invocationId`, resultado e duração.

## Validação de entrada e erros HTTP

O módulo compartilhado `src/http/validation.ts` valida dados com schemas Zod antes que um handler use os valores recebidos. Não há rota demonstrativa registrada. Em handlers futuros, os parâmetros de rota e query podem ser validados com `validateInput`; query usa `request.query` diretamente, e chaves repetidas são representadas como arrays. O corpo JSON é analisado e validado com `validateJsonBody`:

```typescript
const route = validateInput(routeSchema, request.params, { in: "path" });
if (!route.success) return route.response;

const query = validateInput(querySchema, request.query, { in: "query" });
if (!query.success) return query.response;

const body = await validateJsonBody(request, bodySchema);
if (!body.success) return body.response;

// route.data, query.data e body.data têm os tipos inferidos dos schemas.
```

Falhas de JSON malformado e de formato/tipo nos parâmetros de rota ou query retornam `400 Bad Request`. JSON válido que não atende ao schema do corpo retorna `422 Unprocessable Content`. As respostas usam `Content-Type: application/problem+json`, `type: about:blank` e `code: VALIDATION_ERROR`; os itens `errors[]` usam somente `FIELD_REQUIRED`, `INVALID_TYPE`, `INVALID_FORMAT`, `VALUE_OUT_OF_RANGE` ou `INVALID_VALUE`.

Os campos legíveis são apresentados em português, sem incluir valores rejeitados ou mensagens internas do validador. Erros do corpo apontam para o campo por JSON Pointer, escapando `~` como `~0` e `/` como `~1`; erros de rota e query identificam o parâmetro pelo nome.

Os textos públicos de RFC 9457 (`title`, `detail` e `errors[].detail`) são destinados à apresentação direta pelos clientes e devem ser sanitizados. Não inclua exceções, SQL, stack traces, segredos ou valores sensíveis enviados na requisição. Os clientes usam `code` para lógica de máquina e exibem os textos públicos da API mesmo quando um código não estiver presente. Login, sessão e recuperação pública usam mensagens genéricas quando necessário para não revelar se uma conta existe; rotas administrativas autenticadas podem retornar conflitos específicos para orientar o administrador. O idioma é definido pelo contrato de cada endpoint; a resposta técnica de health check conserva o título legado `Service Unavailable`.

Exemplo de erro de campo:

```json
{
  "type": "about:blank",
  "title": "Conteúdo não processável",
  "status": 422,
  "code": "VALIDATION_ERROR",
  "detail": "O conteúdo enviado não atende aos critérios de validação.",
  "errors": [
    {
      "code": "FIELD_REQUIRED",
      "detail": "Este campo é obrigatório.",
      "source": { "in": "body", "pointer": "/nome" }
    }
  ]
}
```

Esse padrão fica disponível para endpoints de negócio. Ele não altera `GET /api/v1/health`, cuja resposta de sucesso e falha permanece específica da verificação de saúde.

## GitHub Actions

O fluxo de integração contínua definido em `.github/workflows/ci.yml` executa `npm ci`, `npm run lint` como etapa obrigatória, checagem de tipos, compilação, testes e `npm audit`, com um PostgreSQL `postgres:18.6-bookworm`.

## Migrations e primeiro administrador

As migrations criam as 16 tabelas de domínio da matriz física V1, agrupadas por assunto. Consulte o estado e aplique-as à base local com:

```bash
npm run db:migrate:status
npm run db:migrate:latest
```

Os comandos de migration e seed aceitam somente hosts de loopback (`127.0.0.0/8`, `::1` ou `localhost`) e falham para hosts remotos. Use `PGHOST=127.0.0.1` na configuração local. As migrations são forward-only: não há comando de rollback e todo `down` de migration falha antes de alterar o schema.

O seed do primeiro administrador é manual e interativo:

```bash
npm run db:seed:admin
```

O seed solicita nome completo e e-mail; a senha é digitada sem eco no terminal, não há senha padrão e uma execução é recusada quando já existe administrador ativo. A senha é armazenada como hash Argon2id com os parâmetros configurados. O seed deve ser executado em uma base local depois das migrations.

Esta API inclui autenticação, ciclo de vida e operações administrativas de contas de alunos, professores e administradores. As telas web/mobile ainda não estão integradas; o transporte de e-mail permanece fake/local; a publicação na Azure e a migração de dados do MongoDB não fazem parte do funcionamento local.

## Problemas comuns

- **`func` não encontrado:** instale o Azure Functions Core Tools v4 e abra um terminal em que `func --version` funcione.
- **A verificação de saúde retorna 503:** confirme que o contêiner PostgreSQL está saudável com `docker compose ps` e que `local.settings.json` contém os mesmos valores do `.env`.
- **Aviso de AzureWebJobsStorage/Azurite:** o exemplo local usa `UseDevelopmentStorage=true`. Esta API HTTP não usa Azure Storage; sem Azurite, o host pode registrar um aviso de tempo limite de armazenamento mesmo quando a rota HTTP inicia. Se o host não registrar a Function, confira a saída do Core Tools e a disponibilidade do Azurite.
- **O código TypeScript mudou, mas a rota não atualizou:** rode `npm run build` novamente e reinicie `npm start`.
