# Black Crown Barber

Modelo reutilizável de site institucional e módulo opcional de painel/agendamento. O design preto e dourado existente foi mantido. A estrutura foi dividida para facilitar a personalização e para que sites institucionais possam ser publicados sem painel.

## Arquivos

- `index.html`: estrutura e visual da página.
- `app.js`: renderização pública e painel administrativo.
- `site-config.js`: configuração da cópia institucional estática, sem painel.
- `server.js`: API, autenticação, agendamento e persistência SQLite.
- `data/`: criado pelo servidor; contém o banco e as imagens enviadas. Não versionar nem compartilhar entre clientes.

## Requisitos

Node.js 22.13 ou superior, com suporte ao módulo nativo `node:sqlite`. O desenvolvimento foi verificado no Node.js 24.22.1. Não são necessárias dependências npm.

## Executar localmente

No PowerShell, entre na pasta `black-crown-app` (a pasta que contém `server.js`). Copie o arquivo de exemplo e inicie o servidor:

```powershell
Copy-Item .env.example .env
$env:DATA_DIR = Join-Path $PWD "data"
npm.cmd start
```

`Copy-Item` precisa ser executado nessa pasta do projeto. O arquivo `.env.example` contém somente configurações locais sem segredos; `.env` é ignorado pelo Git. O comando `npm start` carrega `.env` se ele existir e também funciona quando a hospedagem injeta as variáveis diretamente. Variáveis definidas no ambiente têm precedência sobre valores do `.env`. Se preferir iniciar sem npm, use `node --env-file-if-exists=.env server.js`.

Se preferir não criar `.env`, defina as variáveis no PowerShell e use `npm.cmd start`:

```powershell
$env:PORT = "4173"
$env:HOST = "127.0.0.1"
$env:DATA_DIR = Join-Path $PWD "data"
npm.cmd start
```

Abra `http://127.0.0.1:4173`. Não abra o HTML com duplo clique para testar as rotas de API: a API só existe quando o servidor está em execução. No modo com servidor, formulário, painel e conteúdo usam o SQLite. A publicação estática sem servidor é somente institucional: ela não grava agendamentos e deve usar `bookingEnabled: false` em `site-config.js`.

## Criar o primeiro administrador

Pare o servidor e execute na mesma pasta e com o mesmo `DATA_DIR`:

```powershell
node --env-file-if-exists=.env server.js create-admin
```

Informe o e-mail e uma senha de pelo menos 12 caracteres no terminal. Em terminal interativo, a senha não aparece na tela. O comando só cria uma conta e não imprime nem inclui credenciais no frontend.

O painel também oferece alteração autenticada de senha. Para redefinir a senha localmente sem entrar no painel, primeiro pare o servidor. Abra um terminal interativo na pasta do projeto e selecione o mesmo `DATA_DIR` usado pelo servidor:

```powershell
node --env-file-if-exists=.env server.js reset-admin-password
```

O comando localiza a conta existente (se houver mais de uma, pergunta o e-mail), solicita a nova senha duas vezes sem exibir os caracteres e exige no mínimo 12 caracteres. A alteração atualiza apenas o salt, o hash `scrypt` e a data de alteração da conta selecionada; agendamentos, serviços, configurações e o restante do banco são preservados. A senha não deve ser passada como argumento, variável de ambiente ou entrada por pipe. O comando exige terminal interativo e acesso ao host/banco daquela empresa.

Os comandos acima usam o `DATA_DIR` definido em `.env`. Se iniciou o servidor somente com variáveis do PowerShell, defina o mesmo `$env:DATA_DIR` antes de executar `node server.js create-admin` ou `node server.js reset-admin-password`. Depois da redefinição, inicie o servidor normalmente e entre em `/admin` com a senha nova. Há uma conta inicial por implantação; administração de múltiplos funcionários e papéis distintos não está implementada.

## Personalizar para uma empresa

Na versão com servidor, use o painel para editar nome, contatos, fuso, horários gerais, disponibilidade semanal de cada profissional, identidade visual, textos do site, serviços, preços, equipe e imagens. Essas informações são gravadas no SQLite; as imagens enviadas (JPEG, PNG ou WebP, até 2 MB) ficam em `data/uploads/`. Não use `site-config.js` para inserir tokens ou senhas.

Uma instalação nova começa sem serviços e profissionais fictícios. Cadastre dados confirmados pela empresa antes de habilitar agendamentos. O `site-config.js` mantém uma lista vazia de serviços e profissionais para que o pacote institucional não mostre exemplos inventados. O banco já existente conserva os registros atuais: nesta cópia há 10 serviços e 3 profissionais de exemplo, além de nenhuma reserva. O bloqueio de agendamentos já existente continua ativo; edite ou desative os registros de exemplo e desmarque **Pausar agendamentos durante configuração** no painel somente após revisar os dados.

## Banco, isolamento e publicação

Esta implementação usa **uma implantação e um banco SQLite por empresa**. A API não recebe um `tenant_id` controlável pelo navegador: todo o banco daquela instância é da única empresa atendida. Não conecte duas empresas ao mesmo `DATA_DIR`, banco ou diretório de imagens. Para poucos clientes, isso reduz o risco de vazamento entre empresas e deixa a saída de um cliente mais simples; em troca, cada implantação precisa de atualização, monitoramento e backup próprios. O modelo não é multiempresa e não permite escalar o mesmo SQLite por várias réplicas.

O site público não mostra botão administrativo. O formulário e o painel ficam em `/admin` (por exemplo, `https://seudominio.com/admin`) e exigem uma conta criada no servidor. Em um site estático sem servidor, essa rota administrativa não funciona.

Para publicar o módulo de agendamento/painel:

1. Use um servidor Node com volume persistente e uma única instância. Configure `DATA_DIR` com o caminho absoluto do volume, fora da pasta de releases.
2. Em um VPS com Nginx/Caddy, mantenha Node acessível apenas pelo proxy e use `HOST=127.0.0.1`. Em uma plataforma gerenciada que encaminha tráfego diretamente à aplicação, use o endereço de escuta exigido pelo provedor (com frequência `HOST=0.0.0.0`) e a variável `PORT` fornecida por ele.
3. Configure `COOKIE_SECURE=true` quando o tráfego público usar HTTPS. Não publique o painel com esse valor desligado.
4. Configure DNS do domínio da empresa e certificado TLS/HTTPS antes de receber dados reais. O cookie de sessão só recebe o atributo `Secure` quando `COOKIE_SECURE=true`.
5. Crie uma pasta e um banco novos para cada cliente. Não copie o banco de uma empresa para a implantação de outra.
6. Crie a conta administrativa localmente, revise os registros que já existem, configure os dados reais da empresa e carregue fotos autorizadas.
7. Confirme horários, serviço, preço e profissional no fluxo público. Libere os agendamentos só depois de confirmar os dados, HTTPS e backups.

O servidor usa SQLite local e deve rodar em **uma única instância**. Não é adequado para hospedagem serverless que apaga o disco local nem para várias réplicas sem desenho adicional. Para maior volume, vários funcionários ou disponibilidade mais alta, planeje a migração para PostgreSQL gerenciado, gestão de sessão compartilhada e políticas de isolamento antes de aumentar a escala.

## Segurança e dados

- Senhas são armazenadas com `scrypt` e salt aleatório; sessões são aleatórias, de servidor, `HttpOnly` e `SameSite=Strict`, com validade de oito horas.
- Operações de administração exigem sessão válida; alterações verificam a origem e a sessão no servidor. Há limite básico de tentativas de login e de solicitações públicas por endereço IP.
- A disponibilidade e a gravação do agendamento ocorrem no servidor. A gravação usa transação SQLite `BEGIN IMMEDIATE`, chave de idempotência e verificações de conflito. O preço, a duração e os nomes do serviço/profissional são registrados como retrato no agendamento.
- Agendamentos começam como **Pendente**. Só a equipe pode alterar o status. Receita inclui apenas agendamentos marcados como **Concluído**.
- Clientes e histórico são consultáveis apenas no painel autenticado. A exportação CSV trata valores que poderiam ser interpretados como fórmulas.
- Os dados são pessoais. Este pacote não define prazo automático de retenção nem executa exclusão periódica. A empresa precisa decidir retenção, solicitações de exclusão e rotina de atendimento antes de operar; a nota configurável do formulário não substitui uma revisão de privacidade ou obrigações legais.
- Para backup, pare o servidor e copie **juntos** o arquivo SQLite e `data/uploads/` para armazenamento protegido. Mantenha cópias criptografadas e teste a restauração em outra pasta antes de depender delas. Não coloque `data/` em Git ou em uma pasta pública da web.
- A redefinição de senha por e-mail, e-mail transacional, alertas, autenticação multifator e auditoria de login ainda não estão configurados.

## Limitações que precisam ser resolvidas antes de uma operação comercial completa

- A base existente ainda contém os 10 serviços e 3 profissionais de exemplo que já estavam salvos; eles não foram apagados nem alterados. Substitua, edite ou desative esses registros antes de abrir o agendamento a clientes. Endereço, telefone, e-mail e WhatsApp precisam ser confirmados.
- Horários gerais e disponibilidade individual por profissional são configuráveis. Ainda não há calendário de feriados ou folgas extraordinárias.
- A equipe pode cancelar, alterar status e reagendar pelo painel. O cliente ainda não tem um link de autoatendimento para cancelar ou remarcar.
- Não há recuperação de senha por e-mail, múltiplos usuários/papéis, notificações automáticas, integração oficial de WhatsApp, webhooks ou pagamentos.
- A hospedagem, DNS, HTTPS, credenciais de acesso ao host, política de retenção e procedimento de backup são configurações externas e continuam a cargo do operador.

## Custos a estimar

- Domínio `.br`: o [Registro.br lista R$ 40 por ano](https://registro.br/dominio); o cliente deve ser o titular.
- Site institucional estático: Cloudflare Pages tem plano gratuito sujeito a limites. A [Vercel lista Pro por US$ 20/mês](https://vercel.com/pricing); o plano Hobby é para uso pessoal e não deve ser presumido como plano comercial para sites de clientes ([termos do Hobby](https://vercel.com/docs/plans/hobby)).
- API e SQLite: este modelo requer um processo Node persistente e volume de disco. A cobrança depende do VPS/provedor escolhido; planos serverless com disco efêmero não servem para o SQLite desta versão. O código não está conectado a um host.
- Alternativa futura gerenciada: migrar para PostgreSQL/Auth gerenciados muda a arquitetura; o [Supabase Pro começa em US$ 25/mês](https://supabase.com/pricing), com limites e custos adicionais conforme compute/uso. Supabase não está conectado neste projeto.
- WhatsApp oficial e e-mail transacional não estão configurados; custos dependem da conta, país, fornecedor e volume.

O exemplo barato para iniciar é: domínio pago pelo cliente, publicação estática no pacote básico e, para o adicional de agendamento, uma instância Node persistente com banco e imagens isolados por empresa. Some custo do servidor, backups, e-mail (se adotado), armazenamento e sua manutenção. Preços mudam e podem ter impostos/câmbio; valide no provedor ao fechar cada contrato. Não há serviços ou contas externas pagos conectados neste projeto.

## Verificações realizadas

Execute `npm run check` para verificar a sintaxe e `npm test` para rodar o fluxo HTTP completo em um banco temporário isolado. O teste cria e apaga somente os próprios registros temporários; não lê nem altera `data/black-crown.sqlite`. Não use informações reais de clientes nos testes.
