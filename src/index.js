const {
  BaseKonnector,
  errors,
  requestFactory,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')
const requestHTML = requestFactory({
  cheerio: true,
  json: false,
  jar: true
})
const requestJSON = requestFactory({
  cheerio: false,
  json: true,
  jar: true
})
const pdf = require('pdfjs')
const { URL } = require('url')
const html2pdf = require('./html2pdf')
const moment = require('moment')
const NBSPACE = '\xa0'

const baseUrl = 'https://www.just-eat.fr'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')
  // The BaseKonnector instance expects a Promise as return of the function
  log('info', 'Fetching the list of documents')
  const $ = await requestHTML(`${baseUrl}/chez-moi/Dernieres-commandes`)
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  log('info', 'Parsing list of documents')
  const documents = await parseDocuments($)
  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: ['just eat'],
    contentType: 'application/pdf'
  })
}

// this shows authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
// even if this in another domain here, but it works as an example
async function authenticate(username, password) {
  // First request to get the cookie and CSRF token
  const $ = await requestHTML(`${baseUrl}/connexion`)

  try {
    await requestJSON({
      uri: `${baseUrl}/connexion`,
      method: 'POST',
      body: {
        _token: $('[name="csrf-token"]').attr('content'),
        'do-login': '',
        'login-email': username,
        'login-password': password
      }
    })
  } catch (err) {
    if (err.statusCode === 422) {
      throw new Error(errors.LOGIN_FAILED)
    } else throw err
  }

  return requestHTML({
    uri: `${baseUrl}/chez-moi/Dernieres-commandes`
  })
}

// The goal of this function is to parse a html page wrapped by a cheerio instance
// and return an array of js objects which will be saved to the cozy by saveBills (https://github.com/cozy/cozy-konnector-libs/blob/master/docs/api.md#savebills)
async function parseDocuments($) {
  // you can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const orders = scrape(
    $,
    {
      fileurl: {
        sel: '.button.order-history-details',
        attr: 'href'
      },
      date: {
        sel: '.restaurant-item-date',
        parse: d => moment(d, 'DD/MM/YYYY')
      },
      price: {
        sel: '.price'
      },
      restaurant: {
        sel: '.name'
      }
    },
    '.order.block'
  )
  for (let order of orders) {
    const amount = order.price.split(NBSPACE)[0]
    order.amount = parseFloat(amount.replace(',', '.'))
    order.currency = 'EUR'
    order.vendor = order.restaurant
    order.filename =
      order.date.format('YYYY-MM-DD') + '_' + order.amount + '€' + '.pdf'
    order.date = order.date.toDate()
    const url = new URL(order.fileurl, baseUrl)
    delete order.fileurl
    order.filestream = await billURLToStream(url.toString())
  }
  return orders
}

async function billURLToStream(url) {
  var doc = new pdf.Document()
  const cell = doc.cell({ paddingBottom: 0.5 * pdf.cm }).text()
  cell.add('Généré automatiquement par le connecteur JustEat depuis la page ', {
    font: require('pdfjs/font/Helvetica-Bold'),
    fontSize: 14
  })
  cell.add(url, {
    link: url,
    color: '0x0000FF'
  })
  const $ = await requestHTML(url)
  html2pdf($, doc, $('.content'), { baseURL: url })
  doc.end()
  return doc
}
