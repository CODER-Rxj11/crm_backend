const Invoice = require("../models/invoice.model.js");
const Car = require("../models/car.model");
const Trip = require("../models/trip.model");
const Owner = require("../models/owner.model");
const { ApiError } = require("../utils/ApiError.js");
const { ApiResponse } = require("../utils/ApiResponse.js");
const { catchAsyncErrors } = require("../middlewares/catchAsyncErrors.js");

exports.generateInvoice = catchAsyncErrors(async (req, res) => {
	const { carno, status, end } = req.body;
	// const { date, km } = end;
	// const currentDate = new Date();
	const car = await Car.findOne({ registrationNo: carno }).populate("owner");
	let invoices = [];
	for (const trip of car.trip) {
		const tripend = end.filter((t) => t.id === trip)[0];
		const invoice = await generateInv(trip, tripend, status);
		invoices.push(invoice);
	}

	res.status(201).json(new ApiResponse(200, invoices, "Invoices generated successfully."));
});

const generateInv = async (id, end, status) => {
	const trip = await Trip.findById(id).populate("car");

	if (trip.start.km > end.km) {
		throw new ApiError(401, "end km is not greater than start km");
	}

	trip.end = {
		km: end.km,
		date: end.date || Date.now(),
	};

	await trip.save();
	const dayqty = Math.ceil((trip.end.date - trip.start.date) / (1000 * 60 * 60 * 24));
	const kmqty = Math.ceil(trip.end.km - trip.start.km);

	const dayAmount = (dayqty - trip.offroad) * trip.car.rate.date;
	const kmAmount = kmqty * trip.car.rate.km;

	const total = dayAmount + kmAmount;

	const invoice = await Invoice.create({
		owner: trip.car.owner,
		trip: trip._id,
		car: trip.car._id,
		model: trip.car.model,
		dayQty: dayqty,
		dayRate: trip.car.rate.date,
		dayAmount: dayAmount,
		kmQty: kmqty,
		kmRate: trip.car.rate.km,
		kmAmount: kmAmount,
		totalAmount: total,
		offroad: trip.offroad,
	});

	if (status === false) {
		trip.status = "completed";
		trip.start.km = end.km;
	} else {
		trip.start = {
			date: trip.end.date,
			km: trip.end.km,
		};
		trip.end = null;
		trip.offroad = 0;
	}
	await trip.save();

	return invoice;
};

exports.generateInvoices = catchAsyncErrors(async (req, res) => {
	const currentDate = new Date();
	// TODO: need to change === to !== as invoice is only generated on the 1st of every month
	// if (currentDate.getDate() === 1) {
	// 	throw new ApiError(403, "Invoices can only be generated on the 1st day of the month.");
	// }

	const cars = await Car.find().populate("owner"); // Populate the owner field in the Car document
	if (!cars || cars.length === 0) {
		throw new ApiError(404, "No cars found.");
	}

	const trips = await Trip.aggregate([
		{
			$match: {
				generated: {
					$not: {
						$elemMatch: {
							invoiceGenerationMonth: { $eq: currentDate.getMonth() },
						},
					},
				},
				status: "ongoing",
			},
		},
		{
			$lookup: {
				from: "cars",
				localField: "car",
				foreignField: "_id",
				as: "carDetails",
			},
		},
		{ $unwind: "$carDetails" }, // Deconstruct the carDetails array
		{
			$lookup: {
				from: "owners",
				localField: "carDetails.owner",
				foreignField: "_id",
				as: "ownerDetails",
			},
		},
		{ $unwind: "$ownerDetails" }, // Deconstruct the ownerDetails array
	]);

	// console.log(trips);

	if (!trips || trips.length === 0) {
		throw new ApiError(404, "No trips found to generate invoices.");
	}

	const { end } = req.body;

	if (!end || end.length === 0) {
		throw new ApiError(400, "End kilometers are required.");
	}

	const endMap = new Map(end.map(({ email, km }) => [email, km]));

	const invoicePromises = [];
	const generatedInvoices = [];
	console.log("************************************************************************************************");
	for (const trip of trips) {
		const car = trip.carDetails;
		const carWithOwner = cars.find((c) => c._id.toString() === car._id.toString()); // Find the car from the populated cars array
		if (!carWithOwner) {
			throw new ApiError(404, "Car not found.");
		}
		const owner = carWithOwner.owner; // Access owner from the car document
		const model = car.model;
		const days = Math.ceil((currentDate - trip.start.date) / (1000 * 60 * 60 * 24));
		const endKm = endMap.get(owner.email); // Get the end kilometer for the respective owner

		if (!endKm) {
			throw new ApiError(400, `End kilometer not provided for owner with email ${owner.email}.`);
		}
		// console.log("car", car);
		const dayAmount = days * car.rate.date;
		const kmAmount = (endKm - trip.start.km) * car.rate.km; // Calculate kilometers based on end kilometer
		const totalAmount = dayAmount + kmAmount;

		const tripDocument = await Trip.findById(trip._id);
		if (!tripDocument) {
			throw new ApiError(404, "Trip not found.");
		}

		tripDocument.end = {
			date: currentDate,
			km: endKm,
		};

		await tripDocument.save();

		const newInvoice = new Invoice({
			owner: owner,
			trip: trip._id,
			model: model,
			dayQty: days,
			dayRate: car.rate.date,
			dayAmount: dayAmount,
			kmQty: endKm - trip.start.km, // Calculate kilometers difference
			kmRate: car.rate.km,
			kmAmount: kmAmount,
			totalAmount: totalAmount,
		});

		await newInvoice.save(); // Wait for the invoice to be saved before pushing to the array
		generatedInvoices.push(newInvoice.toObject());

		// Update car's kilometers
		carWithOwner.currentKm = endKm;
		await carWithOwner.save();
	}

	// Mark trips as invoiced
	const tripIds = trips.map((trip) => trip._id);
	await Trip.updateMany({ _id: { $in: tripIds } }, { $push: { generated: currentDate } });

	res.status(201).json(new ApiResponse(200, generatedInvoices, "Invoices generated successfully."));
});

exports.getAllInvoices = catchAsyncErrors(async (req, res) => {
	const allInvoices = await Invoice.find().populate("owner");

	if (!allInvoices || allInvoices.length === 0) {
		throw new ApiError(404, "No invoices found in the database.");
	}
	// Create an empty array to store formatted invoices
	const formattedInvoices = [];

	allInvoices.forEach((invoice) => {
		// Check if the owner is already present in formattedInvoices
		const ownerIndex = formattedInvoices.findIndex((ownerInvoices) => {
			return ownerInvoices.owner._id.toString() === invoice.owner._id.toString();
		});

		// If owner is not present, add the owner along with the current invoice
		if (ownerIndex === -1) {
			formattedInvoices.push({
				owner: invoice.owner,
				invoices: [
					{
						model: invoice.model,
						invoice: [
							{
								invoiceId: invoice._id,
								model: invoice.model,
								dayQty: invoice.dayQty,
								dayRate: invoice.dayRate,
								dayAmount: invoice.dayAmount,
								kmQty: invoice.kmQty,
								kmRate: invoice.kmRate,
								kmAmount: invoice.kmAmount,
								totalAmount: invoice.totalAmount,
								invoiceDate: invoice.invoiceDate,
							},
						],
					},
				],
			});
		} else {
			// If owner is already present, find the model index
			const modelIndex = formattedInvoices[ownerIndex].invoices.findIndex((inv) => {
				return inv.model === invoice.model;
			});

			// If model is not present, add the model along with the current invoice
			if (modelIndex === -1) {
				formattedInvoices[ownerIndex].invoices.push({
					model: invoice.model,
					invoice: [
						{
							invoiceId: invoice._id,
							model: invoice.model,
							dayQty: invoice.dayQty,
							dayRate: invoice.dayRate,
							dayAmount: invoice.dayAmount,
							kmQty: invoice.kmQty,
							kmRate: invoice.kmRate,
							kmAmount: invoice.kmAmount,
							totalAmount: invoice.totalAmount,
							invoiceDate: invoice.invoiceDate,
						},
					],
				});
			} else {
				// If model is already present, add the current invoice
				formattedInvoices[ownerIndex].invoices[modelIndex].invoice.push({
					invoiceId: invoice._id,
					model: invoice.model,
					dayQty: invoice.dayQty,
					dayRate: invoice.dayRate,
					dayAmount: invoice.dayAmount,
					kmQty: invoice.kmQty,
					kmRate: invoice.kmRate,
					kmAmount: invoice.kmAmount,
					totalAmount: invoice.totalAmount,
					invoiceDate: invoice.invoiceDate,
				});
			}
		}
	});

	res.status(200).json(new ApiResponse(200, formattedInvoices, "All invoices retrieved successfully."));
});

// exports.generateInvoice = catchAsyncErrors(async (req, res) => {
// Assuming ownerId is extracted from the request
// 	const ownerId = req.query.id; // Adjust this based on your authentication mechanism
// 	const currentDate = new Date();

// 	// Check if it's the 1st day of the month
// 	if (currentDate.getDate() === 1) {
// 		throw new ApiError(403, "Invoices can only be generated on the 1st day of the month.");
// 	}

// 	const trips = await Trip.find({ invoiceGenerated: { $ne: true } }).populate("car");
// 	if (!trips || trips.length === 0) {
// 		throw new ApiError(404, "No trips found to generate invoices.");
// 	}

// 	console.log(trips);

// 	const invoices = {};

// 	trips.forEach((trip) => {
// 		const car = trip.car;
// 		const model = car.model;
// 		// console.log("car = ", car);
// 		// console.log("model =", model);
// 		if (!invoices[model]) {
// 			invoices[model] = {
// 				dayAmount: 0,
// 				kmAmount: 0,
// 				dayQty: 0,
// 				kmQty: 0,
// 			};
// 		}
// 		// console.log(invoices);
// 		const days = Math.ceil((trip.end.date - trip.start.date) / (1000 * 60 * 60 * 24));
// 		const km = trip.end.km - trip.start.km;

// 		console.log(car.rate.day);
// 		console.log(car.rate.km);
// 		console.log("****************************************************************");
// 		console.log("****************************************************************");

// 		invoices[model].dayAmount += days * car.rate.day;
// 		invoices[model].kmAmount += km * car.rate.km;
// 		invoices[model].dayQty += days;
// 		invoices[model].kmQty += km;
// 	});

// 	console.log(invoices);
// 	console.log("****************************************************************");
// 	console.log("****************************************************************");

// 	const invoicePromises = [];
// 	const generatedInvoices = [];

// 	Object.entries(invoices).forEach(([model, invoice]) => {
// 		const car = trips[0].car; // Assuming all trips have the same car
// 		const totalAmount = invoice.dayAmount + invoice.kmAmount;
// 		const newInvoice = new Invoice({
// 			owner: ownerId,
// 			model,
// 			dayQty: invoice.dayQty,
// 			dayRate: car.rate.day, // Assuming dayRate is set in car model
// 			dayAmount: invoice.dayAmount,
// 			kmQty: invoice.kmQty,
// 			kmRate: car.rate.km, // Assuming kmRate is set in car model
// 			kmAmount: invoice.kmAmount,
// 			totalAmount,
// 		});
// 		invoicePromises.push(newInvoice.save());
// 		generatedInvoices.push(newInvoice.toObject()); // Convert to plain JavaScript object
// 	});

// 	await Promise.all(invoicePromises);

// 	// Mark trips as invoiced
// 	await Trip.updateMany({ _id: { $in: trips.map((trip) => trip._id) } }, { invoiceGenerated: true });

// 	res.status(201).json(new ApiResponse(200, generatedInvoices, "Invoices generated successfully."));
// });

// exports.generateInvoice = catchAsyncErrors(async (req, res) => {
// 	const currentDate = new Date();

// 	// if (currentDate.getDate() !== 1) {
// 	// 	throw new ApiError(403, "Invoices can only be generated on the 1st day of the month.");
// 	// }

// 	const cars = await Car.find();

// 	if (!cars || cars.length === 0) {
// 		throw new ApiError(404, "No cars found.");
// 	}

// 	const trips = await Trip.find({ invoiceGenerated: { $ne: true } }).populate("car");

// 	if (!trips || trips.length === 0) {
// 		throw new ApiError(404, "No trips found to generate invoices.");
// 	}

// 	const invoices = {};

// 	trips.forEach((trip) => {
// 		const car = trip.car;
// 		const owner = car.owner;
// 		const model = car.model;

// 		if (!invoices[owner]) {
// 			invoices[owner] = {};
// 		}

// 		if (!invoices[owner][model]) {
// 			invoices[owner][model] = {
// 				dayAmount: 0,
// 				kmAmount: 0,
// 				dayQty: 0,
// 				kmQty: 0,
// 			};
// 		}

// 		const days = Math.ceil((trip.end.date - trip.start.date) / (1000 * 60 * 60 * 24));
// 		const km = trip.end.km - trip.start.km;

// 		invoices[owner][model].dayAmount += days * car.rate.day;
// 		invoices[owner][model].kmAmount += km * car.rate.km;
// 		invoices[owner][model].dayQty += days;
// 		invoices[owner][model].kmQty += km;
// 	});

// 	const invoicePromises = [];
// 	const generatedInvoices = [];

// 	Object.entries(invoices).forEach(([ownerId, ownerData]) => {
// 		Object.entries(ownerData).forEach(([model, invoice]) => {
// 			const totalAmount = invoice.dayAmount + invoice.kmAmount;
// 			const newInvoice = new Invoice({
// 				owner: ownerId,
// 				model,
// 				dayQty: invoice.dayQty,
// 				dayRate: cars.find((car) => car.owner == ownerId && car.model == model).rate.day,
// 				dayAmount: invoice.dayAmount,
// 				kmQty: invoice.kmQty,
// 				kmRate: cars.find((car) => car.owner == ownerId && car.model == model).rate.km,
// 				kmAmount: invoice.kmAmount,
// 				totalAmount,
// 			});
// 			invoicePromises.push(newInvoice.save());
// 			generatedInvoices.push(newInvoice.toObject());
// 		});
// 	});

// 	await Promise.all(invoicePromises);

// 	// Mark only the selected trips as invoiced
// 	await Trip.updateMany({ _id: { $in: trips.map((trip) => trip._id) } }, { invoiceGenerated: true });

// 	res.status(201).json(new ApiResponse(200, generatedInvoices, "Invoices generated successfully."));
// });
