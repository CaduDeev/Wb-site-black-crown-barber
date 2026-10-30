/*
 * Configuração opcional para publicação institucional sem servidor.
 * Serviços e profissionais começam vazios para evitar conteúdo de exemplo.
 * No pacote com painel, cadastre dados e conteúdo na área administrativa.
 */
window.BCB_CONFIG = {
  settings: {
    name: 'Black Crown Barber', address: '', phone: '', whatsapp: '', email: '',
    footer: '', timezone: 'America/Sao_Paulo', demoMode: false, bookingEnabled: false,
    primaryColor: '#b99b62', accentColor: '#d6c49d', logoImage: '', heroImage: '', galleryImages: [],
    hours: {open:'09:00',close:'19:00',breakStart:'12:00',breakEnd:'13:00',closedDays:[0]},
    siteContent: {
      heroEyebrow: 'Black Crown Barber', heroTitle: 'Seu estilo.\nSua identidade.',
      heroText: 'Cortes, barba e cuidados masculinos com hora marcada, atendimento atento e acabamento na navalha.',
      aboutEyebrow: 'A barbearia', aboutTitle: 'Tradição no ofício, atenção ao detalhe',
      aboutText: 'A Black Crown une técnicas clássicas de barbearia a serviços modernos de cabelo e barba. Cada atendimento começa por uma conversa sobre o que combina com você.',
      servicesEyebrow: 'Serviços', servicesTitle: 'Cada detalhe, um ofício', servicesText: 'Escolha um serviço e siga direto para o agendamento.',
      teamEyebrow: 'Equipe', teamTitle: 'Quem cuida de você', teamText: 'Especialistas para cada tipo de serviço.',
      galleryEyebrow: 'Galeria', galleryTitle: 'Referências de estilo', galleryText: 'Conheça nosso trabalho.'
    }
  },
  services: [],
  professionals: []
};
